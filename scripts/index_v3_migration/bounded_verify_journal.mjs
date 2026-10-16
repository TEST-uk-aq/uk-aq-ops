import fs from 'node:fs';
import path from 'node:path';
import { sha256StableMigrationJson } from '../backup_r2/lib/observation_history_migration_plan_store.mjs';
import { validateManifestPayload } from './recovery_journal_authority.mjs';
import { demand, same, sha256, readJsonBounded, regular, directoryEntries, MiB } from './bounded_verify_store.mjs';

const authenticated = new WeakSet();
export const isAuthenticatedDiskJournal = (journal) => authenticated.has(journal);
export function exactKeys(value, keys, label) {
  demand(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()),
    `${label}: invalid fields`);
}
export function envelope(file, kind, maxBytes = 4 * MiB) {
  const { value, bytes } = readJsonBounded(file, maxBytes);
  exactKeys(value, ['schema_version', 'kind', 'payload', 'payload_sha256'], kind);
  demand(value.schema_version === 1 && value.kind === kind && value.payload && typeof value.payload === 'object' &&
    !Array.isArray(value.payload) && value.payload_sha256 === sha256StableMigrationJson(value.payload),
  `Recovery envelope authentication failed: ${file}`);
  return { value, identity: { sha256: sha256(bytes), byte_size: bytes.length } };
}

// Exact read-only reader: no repair/create options, no journal array, no Maps.
// The brand is granted only after the entire committed chain and exact entry set.
export async function authenticateDiskJournal({ checkpoint, checkpointIdentity, checkpointPath, store, onEntry, validateUpdateStructure,
  maxEntryBytes = 128 * MiB, anchorSequence = 0 }) {
  demand(typeof validateUpdateStructure === 'function', 'Recovery update structure validator is required');
  const root = `${path.resolve(checkpointPath)}.recovery`;
  const entryRoot = path.join(root, 'entries');
  for (const directory of [root, entryRoot]) {
    const stat = fs.lstatSync(directory);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), `Unsafe/missing recovery directory: ${directory}`);
  }
  const manifestRead = envelope(path.join(root, 'manifest.json'), 'uk_aq_observation_history_v3_recovery_manifest');
  const manifest = manifestRead.value;
  validateManifestPayload(manifest.payload);
  const payload = manifest.payload;
  demand(payload.original_checkpoint.sha256 === checkpointIdentity.sha256 &&
    payload.original_checkpoint.byte_size === checkpointIdentity.byte_size &&
    payload.immutable_authority_sha256 === checkpoint.authority_sha256 && payload.migration_run_id === checkpoint.migration_run_id &&
    payload.plan_sha256 === checkpoint.plan_sha256 && same(payload.transition, checkpoint.transition) &&
    payload.target_writer_git_sha === checkpoint.authority.target_writer_git_sha,
  'Recovery manifest contradicts original checkpoint/plan');
  const headRead = envelope(path.join(root, 'head.json'), 'uk_aq_observation_history_v3_recovery_head');
  const head = headRead.value;
  exactKeys(head.payload, ['original_checkpoint_sha256', 'immutable_authority_sha256', 'last_sequence', 'last_entry_sha256'], 'Recovery head');
  const last = head.payload.last_sequence;
  demand(head.payload.original_checkpoint_sha256 === checkpointIdentity.sha256 &&
    head.payload.immutable_authority_sha256 === checkpoint.authority_sha256 &&
    Number.isSafeInteger(last) && last > 0 && last <= 9999999999 && /^[0-9a-f]{64}$/.test(head.payload.last_entry_sha256),
  'Recovery head identity/sequence invalid');
  demand(Number.isSafeInteger(anchorSequence) && anchorSequence >= 0 && anchorSequence <= last, 'Journal anchor outside committed chain');
  let count = 0;
  for (const entry of directoryEntries(entryRoot)) {
    demand(/^\d{10}\.json$/.test(entry.name), `Unexpected recovery entry: ${entry.name}`);
    const sequence = Number(entry.name.slice(0, 10));
    demand(sequence >= 1 && sequence <= last, 'Recovery entry beyond committed head or invalid sequence');
    regular(path.join(entryRoot, entry.name), maxEntryBytes);
    count++;
  }
  demand(count === last, 'Recovery entry set does not equal committed head');
  let previous = null, publicationsAtAnchor = 0;
  for (let sequence = 1; sequence <= last; sequence++) {
    store.assertHeld();
    const file = path.join(entryRoot, `${String(sequence).padStart(10, '0')}.json`);
    const { value: entry } = envelope(file, 'uk_aq_observation_history_v3_recovery_entry', maxEntryBytes);
    exactKeys(entry.payload, ['sequence', 'previous_entry_sha256', 'original_checkpoint_sha256', 'immutable_authority_sha256', 'updates'], `Journal ${sequence}`);
    demand(entry.payload.sequence === sequence && entry.payload.previous_entry_sha256 === previous &&
      entry.payload.original_checkpoint_sha256 === checkpointIdentity.sha256 &&
      entry.payload.immutable_authority_sha256 === checkpoint.authority_sha256 &&
      entry.payload.updates && typeof entry.payload.updates === 'object' && !Array.isArray(entry.payload.updates),
    `Journal identity/ancestry mismatch at ${sequence}`);
    // Authenticate first, then validate the ENTIRE update before any completion,
    // journal-index or callback replay write. No whole-journal accumulation.
    validateUpdateStructure(entry.payload.updates);
    const seen = new Set(); // at most one bounded journal entry, never global
    for (const completion of entry.payload.updates.completed_objects || []) {
      exactKeys(completion, ['key', 'evidence'], `Completion ${sequence}`);
      demand(typeof completion.key === 'string' && completion.key.trim() && !seen.has(completion.key) &&
        completion.evidence && typeof completion.evidence === 'object' && !Array.isArray(completion.evidence),
      `Invalid or duplicated completion at ${sequence}`);
      seen.add(completion.key);
      const old = store.get('SELECT evidence FROM completed WHERE key=?', completion.key);
      demand(!old || same(JSON.parse(old.evidence), completion.evidence), `Completed-object evidence changed: ${completion.key}`);
      if (!old) store.run('INSERT INTO completed VALUES(?,?,?)', completion.key, JSON.stringify(completion.evidence), sequence);
      store.counters.completion_records++;
    }
    store.run('INSERT INTO journal VALUES(?,?)', sequence, entry.payload_sha256);
    await onEntry(entry.payload.updates, sequence);
    if (sequence <= anchorSequence) publicationsAtAnchor += entry.payload.updates.publication_evidence?.length || 0;
    previous = entry.payload_sha256;
    store.counters.journal_entries = sequence;
    await store.boundary();
  }
  demand(previous === head.payload.last_entry_sha256, 'Recovery terminal SHA differs from head');
  // No second replay. Re-read only the small anchors to reject concurrent edits.
  demand(envelope(path.join(root, 'head.json'), head.kind).identity.sha256 === headRead.identity.sha256 &&
    envelope(path.join(root, 'manifest.json'), manifest.kind).identity.sha256 === manifestRead.identity.sha256,
  'Recovery head/manifest changed during authentication');
  const entries = new Proxy([], { get(_target, property) {
    if (property === 'length') return last;
    if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
      const row = store.get('SELECT sha FROM journal WHERE sequence=?', Number(property) + 1);
      return row ? { payload_sha256: row.sha } : undefined;
    }
    throw new Error('Disk journal supports indexed SHA lookup only');
  } });
  const journal = Object.freeze({ root, manifest, head, entries, last_sequence: last,
    last_entry_sha256: previous, interrupted_append: null,
    anchorSequence, completedAtAnchor: store.get('SELECT COUNT(*) AS n FROM completed WHERE sequence<=?', anchorSequence).n,
    publicationsAtAnchor, headIdentity: headRead.identity, manifestIdentity: manifestRead.identity });
  authenticated.add(journal);
  return journal;
}
