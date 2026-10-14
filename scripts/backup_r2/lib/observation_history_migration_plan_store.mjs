import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function canonicalKeys(value) {
  // stableObject sorts before Object.fromEntries; JavaScript subsequently
  // enumerates array-index keys numerically, ahead of ordinary sorted keys.
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const isIndex = (key) => {
    const number = Number(key);
    return Number.isInteger(number) && number >= 0 && number < 4294967295 && String(number) === key;
  };
  return [...keys.filter(isIndex).sort((a, b) => Number(a) - Number(b)), ...keys.filter((key) => !isIndex(key))];
}

// This is the byte-for-byte streaming equivalent of stableMigrationJson for
// migration authority's JSON values. A primitive is the largest string made
// by JSON.stringify; no complete plan or large array is materialised.
export function* canonicalMigrationJsonChunks(value, depth = 0) {
  if (Array.isArray(value)) {
    if (!value.length) { yield '[]'; return; }
    yield '[\n';
    for (let index = 0; index < value.length; index += 1) {
      yield '  '.repeat(depth + 1);
      yield* canonicalMigrationJsonChunks(value[index] === undefined ? null : value[index], depth + 1);
      yield index + 1 === value.length ? '\n' : ',\n';
    }
    yield `${'  '.repeat(depth)}]`;
    return;
  }
  if (value && typeof value === 'object') {
    const keys = canonicalKeys(value);
    if (!keys.length) { yield '{}'; return; }
    yield '{\n';
    for (const [index, key] of keys.entries()) {
      yield `${'  '.repeat(depth + 1)}${JSON.stringify(key)}: `;
      yield* canonicalMigrationJsonChunks(value[key], depth + 1);
      yield index + 1 === keys.length ? '\n' : ',\n';
    }
    yield `${'  '.repeat(depth)}}`;
    return;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Unsupported migration authority JSON value');
  yield encoded;
}

export function sha256StableMigrationJson(value) {
  const hash = createHash('sha256');
  for (const chunk of canonicalMigrationJsonChunks(value)) hash.update(chunk);
  hash.update('\n');
  return hash.digest('hex');
}

const FORMAT = 'uk_aq_migration_plan_shards_v1';
const MAX_SHARD_BYTES = 4 * 1024 * 1024;
const MAX_SHARDS = 100_000;
const HEX = /^[0-9a-f]{64}$/;

function canonicalSizeAtMost(value, limit = MAX_SHARD_BYTES) {
  let size = 1; // final newline
  for (const chunk of canonicalMigrationJsonChunks(value)) {
    size += Buffer.byteLength(chunk);
    if (size > limit) return false;
  }
  return true;
}

function durableWrite(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDurableDirectory(directory) {
  const missing = [];
  let current = path.resolve(directory);
  while (!fs.existsSync(current)) { missing.push(current); current = path.dirname(current); }
  for (const target of missing.reverse()) {
    fs.mkdirSync(target, { mode: 0o700 });
    fsyncDirectory(path.dirname(target));
  }
}

function assertRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Migration plan shard is not a regular file: ${file}`);
  return stat;
}

export function persistShardedMigrationPlan(rootPath, plan) {
  const root = path.resolve(rootPath);
  if (fs.existsSync(root)) throw new Error(`Migration plan shard store already exists: ${root}`);
  ensureDurableDirectory(path.dirname(root));
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  fsyncDirectory(path.dirname(root));
  const shards = [];
  const leaf = (value) => {
    if (shards.length >= MAX_SHARDS) throw new Error('Migration plan exceeds the bounded shard count');
    if (!canonicalSizeAtMost(value)) throw new Error('Migration plan leaf exceeds the shard byte limit');
    const bytes = Buffer.from(`${[...canonicalMigrationJsonChunks(value)].join('')}\n`);
    if (bytes.byteLength > MAX_SHARD_BYTES) throw new Error('Migration plan shard exceeds the byte limit');
    const position = shards.length;
    const name = `${String(position).padStart(8, '0')}.json`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    durableWrite(path.join(root, name), bytes);
    const descriptor = { kind: 'leaf', position, name, byte_size: bytes.byteLength, sha256 };
    shards.push(descriptor);
    return descriptor;
  };
  const encode = (value) => {
    if (canonicalSizeAtMost(value)) return leaf(value);
    if (typeof value === 'string') {
      const parts = [];
      for (let offset = 0; offset < value.length; offset += 256 * 1024) {
        parts.push(leaf(value.slice(offset, offset + 256 * 1024)));
      }
      return { kind: 'string', code_unit_length: value.length, parts };
    }
    if (Array.isArray(value)) {
      const parts = [];
      let group = [];
      const flush = () => {
        if (group.length) { parts.push({ count: group.length, node: leaf(group) }); group = []; }
      };
      for (const original of value) {
        const item = original === undefined ? null : original;
        if (!canonicalSizeAtMost(item)) {
          flush();
          parts.push({ count: 1, node: encode(item) });
        } else if (group.length < 64 && canonicalSizeAtMost([...group, item])) {
          group.push(item);
        } else {
          flush();
          group.push(item);
        }
      }
      flush();
      return { kind: 'array', length: value.length, parts };
    }
    if (value && typeof value === 'object') {
      return { kind: 'object', properties: canonicalKeys(value)
        .map((key) => ({ key, node: encode(value[key]) })) };
    }
    throw new Error('An individual migration plan primitive exceeds the shard byte limit');
  };
  const tree = encode(plan);
  fsyncDirectory(root);
  const payload = { format: FORMAT, migration_run_id: plan.migration_run_id,
    plan_sha256: plan.plan_sha256, environment: plan.environment?.environment,
    target_writer_git_sha: plan.target_writer_git_sha,
    full_plan_sha256: sha256StableMigrationJson(plan), shard_count: shards.length, tree };
  const master = { kind: 'uk_aq_observation_history_v3_complete_plan_master',
    payload, payload_sha256: sha256StableMigrationJson(payload) };
  if (!canonicalSizeAtMost(master)) throw new Error('Migration plan master exceeds its bounded byte limit');
  durableWrite(path.join(root, 'master.json'), Buffer.from(`${[...canonicalMigrationJsonChunks(master)].join('')}\n`));
  fsyncDirectory(root);
  return { format: FORMAT, master_path: path.join(root, 'master.json'),
    master_sha256: sha256StableMigrationJson(master), full_plan_sha256: payload.full_plan_sha256 };
}

export function readShardedMigrationPlan(reference) {
  if (reference?.format !== FORMAT || !HEX.test(reference?.master_sha256 || '') ||
      !HEX.test(reference?.full_plan_sha256 || '') ||
      path.basename(reference?.master_path || '') !== 'master.json') throw new Error('Unsupported migration plan shard reference');
  const masterPath = path.resolve(reference.master_path);
  if (assertRegular(masterPath).size > MAX_SHARD_BYTES) throw new Error('Migration plan master exceeds the byte limit');
  const master = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
  const payload = master?.payload;
  if (master?.kind !== 'uk_aq_observation_history_v3_complete_plan_master' ||
      payload?.format !== FORMAT || master.payload_sha256 !== sha256StableMigrationJson(payload) ||
      reference.master_sha256 !== sha256StableMigrationJson(master) ||
      !Number.isSafeInteger(payload.shard_count) || payload.shard_count < 1 ||
      payload.shard_count > MAX_SHARDS) throw new Error('Migration plan master authentication failed');
  const root = path.dirname(masterPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Migration plan shard root is not a regular directory');
  const actualNames = fs.readdirSync(root).sort();
  const expectedNames = ['master.json', ...Array.from({ length: payload.shard_count }, (_, i) => `${String(i).padStart(8, '0')}.json`)].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Migration plan shard set is missing, duplicated or contains extra files');
  let nextPosition = 0;
  const decode = (node) => {
    if (node?.kind === 'leaf') {
      const position = nextPosition++;
      const name = `${String(position).padStart(8, '0')}.json`;
      if (node.position !== position || node.name !== name || !HEX.test(node.sha256 || '') ||
          !Number.isSafeInteger(node.byte_size) || node.byte_size < 1 || node.byte_size > MAX_SHARD_BYTES) throw new Error('Migration plan shard order or descriptor is invalid');
      const file = path.join(root, name);
      if (assertRegular(file).size !== node.byte_size) throw new Error(`Migration plan shard size differs: ${name}`);
      const bytes = fs.readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') !== node.sha256) throw new Error(`Migration plan shard SHA-256 differs: ${name}`);
      const value = JSON.parse(bytes.toString('utf8'));
      if (sha256StableMigrationJson(value) !== node.sha256) throw new Error(`Migration plan shard is not canonical: ${name}`);
      return value;
    }
    if (node?.kind === 'array' && Number.isSafeInteger(node.length) && node.length >= 0 && Array.isArray(node.parts)) {
      const output = [];
      for (const part of node.parts) {
        if (!Number.isSafeInteger(part.count) || part.count < 1) throw new Error('Invalid migration plan array span');
        const value = decode(part.node);
        if (part.node.kind === 'leaf') {
          if (!Array.isArray(value) || value.length !== part.count) throw new Error('Migration plan array shard count differs');
          output.push(...value);
        } else {
          if (part.count !== 1) throw new Error('Migration plan recursive array span differs');
          output.push(value);
        }
      }
      if (output.length !== node.length) throw new Error('Migration plan array length differs');
      return output;
    }
    if (node?.kind === 'string' && Number.isSafeInteger(node.code_unit_length) && node.code_unit_length > 0 && Array.isArray(node.parts)) {
      const parts = node.parts.map((part) => decode(part));
      if (parts.some((part) => typeof part !== 'string')) throw new Error('Migration plan string shard is invalid');
      const value = parts.join('');
      if (value.length !== node.code_unit_length) throw new Error('Migration plan string length differs');
      return value;
    }
    if (node?.kind === 'object' && Array.isArray(node.properties)) {
      const output = {};
      const keys = [];
      for (const entry of node.properties) {
        if (typeof entry.key !== 'string' || entry.key === '__proto__' || keys.includes(entry.key)) throw new Error('Migration plan object keys are invalid');
        Object.defineProperty(output, entry.key, { value: decode(entry.node), enumerable: true, writable: true, configurable: true });
        keys.push(entry.key);
      }
      if (JSON.stringify(keys) !== JSON.stringify(canonicalKeys(output))) throw new Error('Migration plan object key order is invalid');
      return output;
    }
    throw new Error('Invalid migration plan shard tree');
  };
  const plan = decode(payload.tree);
  if (nextPosition !== payload.shard_count ||
      sha256StableMigrationJson(plan) !== payload.full_plan_sha256 ||
      reference.full_plan_sha256 !== payload.full_plan_sha256 ||
      plan?.plan_sha256 !== payload.plan_sha256 ||
      plan?.migration_run_id !== payload.migration_run_id ||
      plan?.environment?.environment !== payload.environment ||
      plan?.target_writer_git_sha !== payload.target_writer_git_sha) throw new Error('Complete migration plan authority differs from the authenticated master');
  return { plan, full_plan_sha256: payload.full_plan_sha256 };
}
