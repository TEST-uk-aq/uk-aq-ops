// Disposable verification state only. This database never grants recovery authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256StableMigrationJson } from '../backup_r2/lib/observation_history_migration_plan_store.mjs';

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const LOGICAL_ROW_BATCH_SIZE = 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const same = (a, b) => sha256StableMigrationJson(a) === sha256StableMigrationJson(b);
export const demand = (condition, message) => { if (!condition) throw new Error(message); };
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function* directoryEntries(root) {
  const directory = fs.opendirSync(root);
  try { for (let entry; (entry = directory.readSync()) !== null;) yield entry; }
  finally { directory.closeSync(); }
}

export function regular(file, maxBytes = 128 * MiB) {
  const stat = fs.lstatSync(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    `Missing, unsafe or oversized evidence file: ${file} (limit ${maxBytes})`);
  return stat;
}

export function readJsonBounded(file, maxBytes = 128 * MiB) {
  regular(file, maxBytes);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    demand(stat.isFile() && stat.size <= maxBytes, `Evidence changed before open: ${file}`);
    const bytes = fs.readFileSync(fd);
    demand(bytes.length === stat.size && bytes.length <= maxBytes, `Evidence size changed: ${file}`);
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } finally { fs.closeSync(fd); }
}

export async function fileIdentity(file, assertHeld) {
  regular(file, Number.MAX_SAFE_INTEGER);
  const hash = createHash('sha256');
  let byte_size = 0;
  for await (const bytes of fs.createReadStream(file, { highWaterMark: 256 * 1024, flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW })) {
    assertHeld();
    byte_size += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), byte_size };
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export class VerificationStore {
  static async open({ scratchDirectory, evidenceDirectory, repositoryRoot, assertHeld,
    batchSize = 128, maxScratchBytes = 32 * GiB, reserveBytes = 8 * GiB }) {
    const parent = fs.realpathSync(scratchDirectory);
    demand(!/dropbox/i.test(parent), 'Verification scratch must be outside Dropbox');
    const evidence = fs.realpathSync(evidenceDirectory);
    demand(!inside(evidence, parent) && !inside(repositoryRoot, parent), 'Scratch must be outside evidence and the repository');
    const stat = fs.lstatSync(scratchDirectory);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), 'Select an existing regular scratch directory');
    const space = fs.statfsSync(parent);
    demand(space.bavail * space.bsize >= maxScratchBytes + reserveBytes,
      `Insufficient scratch capacity; require ${maxScratchBytes + reserveBytes} available bytes`);
    // Optional runtime capability: the existing Node >=20 paths never import node:sqlite.
    const { DatabaseSync } = await import('node:sqlite');
    const root = fs.mkdtempSync(path.join(parent, 'index-v3-verify-'));
    fs.chmodSync(root, 0o700);
    // Standard process-local SQLite spill directory, never evidence/Dropbox.
    process.env.SQLITE_TMPDIR = root;
    const db = new DatabaseSync(path.join(root, 'verification.sqlite'));
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE;
      PRAGMA cache_size=-32768; PRAGMA mmap_size=0;
      PRAGMA max_page_count=${Math.floor(maxScratchBytes / 4096)};
      CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent INTEGER, name TEXT, ordinal INTEGER, kind TEXT, value TEXT);
      CREATE UNIQUE INDEX node_children ON nodes(parent,ordinal);
      CREATE UNIQUE INDEX node_names ON nodes(parent,name);
      CREATE TABLE prepared(id TEXT PRIMARY KEY, ordinal INTEGER UNIQUE, record TEXT NOT NULL);
      CREATE TABLE completed(key TEXT PRIMARY KEY COLLATE BINARY, evidence TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE journal(sequence INTEGER PRIMARY KEY, sha TEXT NOT NULL);
      CREATE TABLE publications(id INTEGER PRIMARY KEY, key TEXT, evidence TEXT NOT NULL);
      CREATE INDEX publications_key ON publications(key);
      CREATE TABLE objects(key TEXT PRIMARY KEY COLLATE BINARY, size INTEGER, sha TEXT, stage TEXT,
        rank INTEGER, v3 INTEGER, external INTEGER, descriptor TEXT, indegree INTEGER DEFAULT 0,
        position INTEGER, verified INTEGER DEFAULT 0);
      CREATE INDEX eligible_objects ON objects(v3,indegree,position,rank,key);
      CREATE UNIQUE INDEX object_positions ON objects(position) WHERE v3=1 AND position IS NOT NULL;
      CREATE INDEX external_objects ON objects(external,key);
      CREATE TABLE edges(parent TEXT, child TEXT, size INTEGER, sha TEXT, relation TEXT, kind TEXT,
        PRIMARY KEY(parent,relation,child));
      CREATE INDEX outgoing_edges ON edges(child,parent);
      CREATE TABLE bindings(id INTEGER PRIMARY KEY, connector INTEGER, pollutant TEXT);
      CREATE TABLE summaries(kind TEXT, key TEXT, value TEXT, PRIMARY KEY(kind,key));
      CREATE TABLE logical_rows(encoded TEXT NOT NULL COLLATE BINARY);
      CREATE INDEX logical_row_order ON logical_rows(encoded);`);
    return new VerificationStore({ root, db, assertHeld, batchSize, reserveBytes, maxScratchBytes });
  }

  constructor(options) {
    Object.assign(this, options);
    this.logicalRowBatchSize = LOGICAL_ROW_BATCH_SIZE;
    this.statements = new Map();
    this.started = Date.now(); this.lastProgress = 0;
    this.counters = { journal_entries: 0, completion_records: 0, publication_records: 0, r2_dependencies: 0, logical_partitions: 0 };
    this.phase = 'initialising'; this.state = 'IN_PROGRESS';
    this.db.exec('BEGIN'); this.pending = 0;
  }
  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  run(sql, ...args) { return this.statement(sql).run(...args); }
  get(sql, ...args) { return this.statement(sql).get(...args); }
  iterate(sql, ...args) { return this.statement(sql).iterate(...args); }
  count(table) { return this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
  flush() { this.db.exec('COMMIT; BEGIN'); this.pending = 0; }
  async boundary(force = false) {
    this.assertHeld();
    if (++this.pending >= this.batchSize || force) {
      this.flush(); this.progress(); await tick(); this.assertHeld();
    }
  }
  // Logical-row writes use their own larger batch so the existing general
  // transaction cadence remains unchanged for journal/index work.
  async logicalWriteBoundary() {
    this.assertHeld();
    this.flush(); this.progress(); await tick(); this.assertHeld();
  }
  // Never commit or otherwise touch SQLite while an ordered row iterator is
  // active. This boundary runs the existing throttled resource/progress gate,
  // yields, and reasserts the supervised lock.
  async logicalReadBoundary() {
    this.assertHeld();
    this.progress(); await tick(); this.assertHeld();
  }
  progress(force = false) {
    if (!force && Date.now() - this.lastProgress < 15000) return;
    this.lastProgress = Date.now();
    demand(process.memoryUsage().rss <= 6 * GiB, 'Process RSS exceeds 6 GiB verification budget; incomplete');
    const disk = fs.statfsSync(this.root);
    demand(disk.bavail * disk.bsize >= this.reserveBytes, 'Scratch disk reserve exhausted; verification incomplete');
    let scratch_bytes = 0;
    for (const name of fs.readdirSync(this.root)) scratch_bytes += fs.statSync(path.join(this.root, name)).size;
    demand(scratch_bytes <= this.maxScratchBytes, 'Scratch byte budget exhausted; verification incomplete');
    const record = { kind: 'bounded_index_v3_verification_progress', state: this.state,
      phase: this.phase, elapsed_seconds: Math.floor((Date.now() - this.started) / 1000),
      ...this.counters, memory: process.memoryUsage(), scratch_bytes,
      accepted_result: false, scratch_authority: false };
    fs.writeFileSync(path.join(this.root, 'progress.pending.json'), JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.renameSync(path.join(this.root, 'progress.pending.json'), path.join(this.root, 'progress.json'));
    process.stderr.write(JSON.stringify(record) + '\n');
  }
  summary(kind, key, value) {
    this.run('INSERT INTO summaries VALUES(?,?,?)', kind, key, JSON.stringify(value));
  }
  *summaries(kind) {
    for (const row of this.iterate('SELECT value FROM summaries WHERE kind=? ORDER BY key COLLATE BINARY', kind)) yield JSON.parse(row.value);
  }
  *summariesPrefix(kind, prefix) {
    for (const row of this.iterate('SELECT value FROM summaries WHERE kind=? AND key>=? AND key<? ORDER BY key COLLATE BINARY',
      kind, prefix, `${prefix}\uffff`)) yield JSON.parse(row.value);
  }
  close() {
    if (!this.db) return;
    this.db.exec('COMMIT'); this.db.close(); this.db = null;
  }
}

// The complete plan is a disk tree. No consumer may materialise its root.
// Leaf shards are <=4 MiB under the existing format. All reassembly has a cap.
export class DiskPlan {
  constructor(store, maxValueBytes = 64 * MiB) { this.store = store; this.maxValueBytes = maxValueBytes; }
  node(id) { return this.store.get('SELECT * FROM nodes WHERE id=?', id); }
  child(id, name) {
    const result = this.store.get('SELECT id FROM nodes WHERE parent=? AND name=?', id, String(name));
    demand(result, `Plan field missing: ${name}`); return result.id;
  }
  at(...names) { let id = this.root; for (const name of names) id = this.child(id, name); return id; }
  *children(id) {
    // A recursive walk must not re-enter a live StatementSync iterator. Keyset
    // lookups retain no ancestor result arrays or active SQLite cursors.
    let ordinal = -1;
    for (;;) {
      const row = this.store.get('SELECT * FROM nodes WHERE parent=? AND ordinal>? ORDER BY ordinal LIMIT 1', id, ordinal);
      if (!row) return;
      ordinal = row.ordinal; yield row;
    }
  }
  length(id) { return this.store.get('SELECT COUNT(*) AS n FROM nodes WHERE parent=?', id).n; }
  put(value, parent = null, name = '', ordinal = 0, depth = 0) {
    demand(depth <= 128, 'Plan nesting exceeds bounded depth');
    const kind = Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'primitive';
    const id = Number(this.store.run('INSERT INTO nodes(parent,name,ordinal,kind,value) VALUES(?,?,?,?,?)',
      parent, name, ordinal, kind, kind === 'primitive' ? JSON.stringify(value) : null).lastInsertRowid);
    if (kind !== 'primitive') {
      // Match stableObject/JSON.stringify, including JS numeric property ordering.
      const keys = kind === 'array' ? Object.keys(value) : Object.keys(Object.fromEntries(Object.keys(value).sort().map((key) => [key, null])));
      for (const [index, key] of keys.entries()) this.put(value[key], id, key, index, depth + 1);
    }
    return id;
  }
  get(id) {
    let size = 0;
    const read = (nodeId, depth) => {
      demand(depth <= 128, 'Plan materialisation depth exceeded');
      const node = this.node(nodeId);
      size += (node.value?.length || 0) * 2 + node.name.length * 2 + 32;
      demand(size <= this.maxValueBytes, 'Selected plan value exceeds materialisation budget');
      if (node.kind === 'primitive') return JSON.parse(node.value);
      const result = node.kind === 'array' ? [] : {};
      for (const child of this.children(nodeId)) Object.defineProperty(result, child.name,
        { value: read(child.id, depth + 1), enumerable: true, configurable: true, writable: true });
      return result;
    };
    return read(id, 0);
  }
  value(...names) { return this.get(this.at(...names)); }
  *values(...names) { for (const child of this.children(this.at(...names))) yield this.get(child.id); }
  *chunks(id, depth = 0) {
    demand(depth <= 128, 'Plan hash depth exceeded');
    const node = this.node(id);
    if (node.kind === 'primitive') { yield node.value; return; }
    const array = node.kind === 'array', count = this.length(id);
    if (!count) { yield array ? '[]' : '{}'; return; }
    yield array ? '[\n' : '{\n';
    let index = 0;
    for (const child of this.children(id)) {
      yield '  '.repeat(depth + 1);
      if (!array) yield `${JSON.stringify(child.name)}: `;
      yield* this.chunks(child.id, depth + 1);
      yield ++index === count ? '\n' : ',\n';
    }
    yield '  '.repeat(depth) + (array ? ']' : '}');
  }
  async hash(id) {
    const hash = createHash('sha256'); let count = 0;
    for (const chunk of this.chunks(id)) {
      hash.update(chunk);
      if (++count % 8192 === 0) await this.store.boundary(true);
    }
    hash.update('\n'); return hash.digest('hex');
  }
  async importShards(reference, relocate) {
    const format = 'uk_aq_migration_plan_shards_v1', hex = /^[0-9a-f]{64}$/;
    demand(reference?.format === format && hex.test(reference.master_sha256) && hex.test(reference.full_plan_sha256) &&
      path.basename(reference.master_path) === 'master.json', 'Invalid sharded plan reference');
    const masterPath = relocate(reference.master_path, 'Sharded migration master');
    const { value: master } = readJsonBounded(masterPath, 4 * MiB);
    const payload = master.payload;
    demand(master.kind === 'uk_aq_observation_history_v3_complete_plan_master' && payload?.format === format &&
      master.payload_sha256 === sha256StableMigrationJson(payload) && reference.master_sha256 === sha256StableMigrationJson(master) &&
      Number.isSafeInteger(payload.shard_count) && payload.shard_count >= 1 && payload.shard_count <= 100000,
    'Sharded plan master authentication failed');
    const root = path.dirname(masterPath);
    demand(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'Unsafe shard root');
    let files = 0;
    for (const entry of directoryEntries(root)) {
      demand(entry.name === 'master.json' || /^\d{8}\.json$/.test(entry.name), 'Unexpected plan shard');
      files++;
    }
    demand(files === payload.shard_count + 1, 'Plan shard file set differs');
    let next = 0;
    const leaf = (node) => {
      const name = `${String(next).padStart(8, '0')}.json`;
      demand(node.position === next++ && node.name === name && hex.test(node.sha256) &&
        Number.isSafeInteger(node.byte_size) && node.byte_size > 0 && node.byte_size <= 4 * MiB,
      'Invalid shard descriptor/order');
      const { value, bytes } = readJsonBounded(path.join(root, name), 4 * MiB);
      demand(bytes.length === node.byte_size && sha256(bytes) === node.sha256 && sha256StableMigrationJson(value) === node.sha256,
        `Plan shard authentication failed: ${name}`);
      return value;
    };
    const decode = async (node, parent = null, name = '', ordinal = 0, depth = 0) => {
      demand(depth <= 128, 'Shard tree nesting exceeds limit');
      if (node?.kind === 'leaf') return this.put(leaf(node), parent, name, ordinal);
      if (node?.kind === 'string') {
        demand(Array.isArray(node.parts) && Number.isSafeInteger(node.code_unit_length) &&
          node.code_unit_length > 0 && node.code_unit_length * 2 <= this.maxValueBytes, 'Oversized/invalid sharded string');
        let value = '';
        for (const part of node.parts) {
          demand(part?.kind === 'leaf', 'Invalid string shard');
          const text = leaf(part); demand(typeof text === 'string', 'Non-string shard fragment');
          value += text; demand(value.length <= node.code_unit_length, 'Sharded string length exceeded');
          await this.store.boundary();
        }
        demand(value.length === node.code_unit_length, 'Sharded string length differs');
        return this.put(value, parent, name, ordinal);
      }
      demand(node?.kind === 'array' || node?.kind === 'object', 'Invalid shard node');
      const id = Number(this.store.run('INSERT INTO nodes(parent,name,ordinal,kind) VALUES(?,?,?,?)', parent, name, ordinal, node.kind).lastInsertRowid);
      if (node.kind === 'array') {
        demand(Number.isSafeInteger(node.length) && node.length >= 0 && Array.isArray(node.parts), 'Invalid shard array');
        let position = 0;
        for (const part of node.parts) {
          demand(Number.isSafeInteger(part.count) && part.count > 0, 'Invalid shard array span');
          if (part.node?.kind === 'leaf') {
            const values = leaf(part.node);
            demand(Array.isArray(values) && values.length === part.count, 'Shard array count differs');
            for (const value of values) { this.put(value, id, String(position), position); position++; }
          } else {
            demand(part.count === 1, 'Invalid recursive shard span');
            await decode(part.node, id, String(position), position, depth + 1); position++;
          }
          await this.store.boundary();
        }
        demand(position === node.length, 'Shard array length differs');
      } else {
        demand(Array.isArray(node.properties), 'Invalid shard object');
        const keys = node.properties.map((entry) => entry.key);
        demand(keys.every((key) => typeof key === 'string' && key !== '__proto__') && new Set(keys).size === keys.length &&
          same(keys, Object.keys(Object.fromEntries([...keys].sort().map((key) => [key, null])))), 'Shard object keys/order differ');
        for (const [index, entry] of node.properties.entries()) await decode(entry.node, id, entry.key, index, depth + 1);
      }
      return id;
    };
    this.root = await decode(payload.tree);
    demand(next === payload.shard_count && reference.full_plan_sha256 === payload.full_plan_sha256 &&
      await this.hash(this.root) === payload.full_plan_sha256, 'Full sharded plan SHA-256 differs');
    for (const [field, expected] of [['plan_sha256', payload.plan_sha256], ['migration_run_id', payload.migration_run_id],
      ['target_writer_git_sha', payload.target_writer_git_sha]]) demand(this.value(field) === expected, `Master ${field} differs`);
    demand(this.value('environment', 'environment') === payload.environment, 'Master environment differs');
    return this;
  }
}
