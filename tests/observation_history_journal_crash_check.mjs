// Narrow filesystem durability check. No migration execution or cloud adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableRecoveryJson, recoverySha256 } from '../scripts/index_v3_migration/recovery_journal_authority.mjs';
const { buildObservationHistoryV3RecoveryProgressContext: openJournal } =
  await import('../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'uk-aq-journal-crash-'));
const hash = (value) => recoverySha256(stableRecoveryJson(value));
const envelope = (kind, payload) => ({ schema_version: 1, kind, payload, payload_sha256: hash(payload) });
function durableWrite(target, value) {
  const fd = fs.openSync(target, 'w', 0o600);
  try { fs.writeFileSync(fd, stableRecoveryJson(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
async function fixture(name) {
  const root = path.join(temporary, name);
  fs.mkdirSync(root);
  const transition = { kind: 'v2-to-v3', source_index_generation: 'v2', target_index_generation: 'v3', authority_switch_required: true };
  // Minimal immutable authority accepted by the production checkpoint/journal
  // primitives; these target identities are never sent to an object adapter.
  const bindings = [1, 2, 3].map((id) => ({ key: `history/_index_v3/timeseries_binding/timeseries_id=${id}.json`, byte_size: 3, sha256: recoverySha256('{}\n') }));
  const planIdentity = { transition, bindings: { bindings, manifests: [] } };
  const authority = { transition, plan_identity: planIdentity, plan_sha256: hash(planIdentity),
    migration_run_id: 'local-journal-boundary', target_writer_git_sha: 'c'.repeat(40),
    units: [], bindings: planIdentity.bindings, runner: { runner_kind: 'local', runner_profile: 'local-conservative' } };
  const base = { schema_version: 1, kind: 'uk_aq_observation_history_v3_migration_checkpoint',
    transition, migration_run_id: authority.migration_run_id, plan_sha256: authority.plan_sha256,
    authority, authority_sha256: hash(authority), progress_format: 'authenticated-journal-v1',
    prepared_units: {}, preparation_order: [], completed_objects: {}, clean_target_admission: null,
    full_verification_complete: false, cutover_ready: false };
  const checkpointPath = path.join(root, 'checkpoint.json');
  durableWrite(checkpointPath, base);
  const options = { checkpointPath, checkpoint: base, repositoryRoot };
  const context = openJournal({ ...options, create: true });
  const evidence = ({ byte_size, sha256 }) => ({ byte_size, sha256, verified: true, durable: true, stored_sha256_verified: false });
  const current = structuredClone(base);
  current.completed_objects[bindings[0].key] = evidence(bindings[0]);
  await context.persistCheckpoint(current, { completedKeys: [bindings[0].key] });
  const oldHead = fs.readFileSync(context.paths.head);
  const append = (sequence = 2, previous = context.entrySha256, update = null) => {
    const binding = bindings[sequence - 1];
    const entry = envelope('uk_aq_observation_history_v3_recovery_entry', {
      sequence, previous_entry_sha256: previous,
      original_checkpoint_sha256: context.manifest.payload.original_checkpoint.sha256,
      immutable_authority_sha256: base.authority_sha256,
      updates: update || { completed_objects: [{ key: binding.key, evidence: evidence(binding) }] },
    });
    const target = path.join(context.paths.entries, `${String(sequence).padStart(10, '0')}.json`);
    durableWrite(target, entry);
    return { entry, target };
  };
  return { context, options, oldHead, append, current, bindings, evidence };
}
try {
  const normal = await fixture('normal');
  assert.deepEqual(openJournal(normal.options).checkpoint, normal.current);

  const single = await fixture('one-tail');
  const { entry } = single.append();
  assert.throws(() => openJournal(single.options), /entry count/); // exact read stays exact
  const recovered = openJournal({ ...single.options, repairHead: true });
  const expected = structuredClone(single.current);
  expected.completed_objects[single.bindings[1].key] = single.evidence(single.bindings[1]);
  assert.deepEqual(recovered.checkpoint, expected);
  const head = JSON.parse(fs.readFileSync(recovered.paths.head));
  assert.equal(head.payload.last_sequence, 2);
  assert.equal(head.payload.last_entry_sha256, entry.payload_sha256);
  assert.equal(head.payload_sha256, hash(head.payload));
  assert.deepEqual(openJournal(single.options).checkpoint, expected);

  for (const scenario of ['two-tails', 'ancestry', 'payload', 'contradiction', 'filename']) {
    const state = await fixture(scenario);
    const tail = state.append(2, scenario === 'ancestry' ? 'f'.repeat(64) : state.context.entrySha256,
      scenario === 'contradiction' ? { completed_objects: [{ key: state.bindings[0].key, evidence: state.evidence(state.bindings[0]) }] } : null);
    if (scenario === 'two-tails') state.append(3, tail.entry.payload_sha256);
    if (scenario === 'payload') {
      tail.entry.payload.updates.completed_objects[0].evidence.byte_size += 1;
      durableWrite(tail.target, tail.entry); // deliberately retain the old envelope SHA
    }
    if (scenario === 'filename') durableWrite(path.join(state.context.paths.entries, 'unexpected.json'), {});
    assert.throws(() => openJournal({ ...state.options, repairHead: true }), /entry count|ancestry|SHA-256|duplicated|filename/);
    assert.deepEqual(fs.readFileSync(state.context.paths.head), state.oldHead);
  }
  const scratch = await fixture('unrenamed-entry');
  fs.mkdirSync(scratch.context.paths.pending, { recursive: true });
  fs.writeFileSync(path.join(scratch.context.paths.pending, 'interrupted-scratch'), '{');
  assert.deepEqual(openJournal({ ...scratch.options, repairHead: true }).checkpoint, scratch.current);
  console.log('PASS: normal replay; durable single-tail repair and exact replay; two tails, broken ancestry, corrupt payload, duplicate completion and unexpected filename rejected; unrenamed scratch preserves previous state.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
