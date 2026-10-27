// Narrow read-only transport over the existing backup rclone/Dropbox config.
// Only `cat` is reachable. No credential discovery, refresh flow, R2 or LIST.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { joinTargetPath, sha256Hex } from '../../backup_r2/lib/rclone.mjs';
import { configuredHistoryDropboxRoot } from '../../backup_r2/lib/history_backup_targets.mjs';
import { requireValid as check } from '../schema.mjs';
import { getObservationHistoryGeneration } from '../../../workers/shared/uk_aq_observation_history_generation.mjs';

export const GENERATION = getObservationHistoryGeneration('v3');
export const CHECKPOINT_KEY = `${GENERATION.backup_state_prefix}/root.json`;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function resolveDropboxSource(env = process.env) {
  check(env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
  return configuredHistoryDropboxRoot(env);
}

export function parseJson(body, key) {
  try { return JSON.parse(decoder.decode(body)); }
  catch { throw new Error(`Invalid UTF-8 JSON: ${key}`); }
}
export function createDropboxReader({ cacheDir, limits, checkpointKey = CHECKPOINT_KEY,
  env = process.env, sourceRoot = resolveDropboxSource(env) }) {
  check(env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
  check(checkpointKey === CHECKPOINT_KEY, 'select the generation-v3 checkpoint root path');
  check(sourceRoot === configuredHistoryDropboxRoot(env), 'Dropbox source root must match shared operator configuration');
  const inventory = new Map(), metadata = new Map();
  const metrics = { read_commands: 0, dropbox_api_requests: null, source_bytes_read: 0,
    parquet_bytes_read: 0, metadata_bytes_read: 0, read_wall_ms: 0, read_cpu_ms: 0,
    cache_hits: 0, stability_read_commands: 0 };
  const rcloneBin = process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || 'rclone';
  const started = performance.now();
  function deadline() { check(performance.now() - started < limits.wallSeconds * 1000, 'invocation wall-time limit exceeded'); }
  function admit(key) {
    check(typeof key === 'string' && key.length < 1024 && !/[\\\s?#%\x00-\x1f]/.test(key)
      && !key.split('/').some(p => !p || p === '.' || p === '..'), 'invalid Dropbox object key');
    check(key === checkpointKey || key.startsWith(`${GENERATION.backup_state_prefix}/`)
      || key.startsWith(`${GENERATION.observations_prefix}/`)
      || key.startsWith(`${GENERATION.timeseries_binding_pack_prefix}/`)
      || key === 'history/_index_v3/verification/latest.json'
      || /^history\/v3\/verification\/connector_id=[1-9]\d*\/manifests\/[a-f0-9]{64}\.json$/.test(key),
    'Dropbox key outside admitted v3 backup domains');
    check(key.endsWith('.json') || key.endsWith('.parquet'), 'unsupported source object type');
  }
  function verify(object, expected) {
    if (!expected) return;
    check(/^[a-f0-9]{64}$/.test(expected.sha256 || ''), `content SHA-256 required: ${object.key}`);
    check(object.sha256 === expected.sha256 && (expected.byte_size === undefined
      || object.byte_size === expected.byte_size), `Dropbox object identity mismatch: ${object.key}`);
  }
  async function fetchBytes(key, cap) {
    deadline();
    check(metrics.read_commands < limits.requests, 'Dropbox read-command budget exceeded');
    check(metrics.source_bytes_read < limits.sourceBytes, 'Dropbox source-byte budget exceeded');
    const remaining = limits.sourceBytes - metrics.source_bytes_read;
    cap = Math.min(cap, remaining);
    const begin = performance.now(), cpu = process.cpuUsage();
    metrics.read_commands++;
    try {
      return await new Promise((resolve, reject) => {
        const chunks = []; let size = 0, failure = null;
        // Existing remote and RCLONE_CONFIG are inherited unchanged. rclone may
        // refresh its local OAuth token normally; no Dropbox content is written.
        const child = spawn(rcloneBin, ['cat', joinTargetPath(sourceRoot, key),
          '--count', String(cap + 1), '--retries', '1', '--low-level-retries', '1',
          '--contimeout', '15s', '--timeout', '30s', '--stats', '0', '--log-level', 'ERROR'],
        { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => { failure = 'read deadline exceeded'; child.kill('SIGKILL'); },
          Math.max(1, Math.min(45_000, limits.wallSeconds * 1000 - (performance.now() - started))));
        child.on('error', () => { failure = 'rclone unavailable or could not start'; });
        child.stdout.on('data', chunk => {
          size += chunk.length; metrics.source_bytes_read += chunk.length;
          metrics[key.endsWith('.parquet') ? 'parquet_bytes_read' : 'metadata_bytes_read'] += chunk.length;
          if (size > cap) { failure = 'object or total byte budget exceeded'; child.kill('SIGKILL'); }
          else chunks.push(chunk);
        });
        child.on('close', code => {
          clearTimeout(timer);
          if (failure || code !== 0) reject(new Error(`Dropbox read failed (${failure || `exit ${code}`}): ${key}`));
          else resolve(Buffer.concat(chunks));
        });
      });
    } finally {
      const used = process.cpuUsage(cpu);
      metrics.read_wall_ms += performance.now() - begin;
      metrics.read_cpu_ms += (used.user + used.system) / 1000;
    }
  }
  async function read(key, { expected = null, fresh = false } = {}) {
    admit(key); deadline();
    const previous = inventory.get(key);
    let body;
    if (previous && !fresh) {
      metrics.cache_hits++;
      body = await fs.readFile(path.join(cacheDir, previous.sha256));
    } else {
      if (!previous) check(inventory.size < limits.objects, 'source-object budget exceeded');
      if (fresh) metrics.stability_read_commands++;
      if (expected?.byte_size !== undefined) check(expected.byte_size > 0
        && expected.byte_size <= limits.objectBytes, `source object exceeds byte limit: ${key}`);
      body = await fetchBytes(key, key.endsWith('.parquet') ? limits.objectBytes : limits.metadataBytes);
    }
    const object = { key, body, byte_size: body.length, sha256: sha256Hex(body) };
    verify(object, expected);
    if (previous) check(previous.sha256 === object.sha256 && previous.byte_size === object.byte_size,
      `selected backup changed during extraction: ${key}`);
    else {
      await fs.writeFile(path.join(cacheDir, object.sha256), body, { mode: 0o600 });
      inventory.set(key, { key, byte_size: object.byte_size, sha256: object.sha256 });
    }
    if (key.endsWith('.json')) metadata.set(key, inventory.get(key));
    return object;
  }
  async function json(key, options) { return parseJson((await read(key, options)).body, key); }
  async function checkSelectedStability(keys) {
    const selected = [...new Set(keys)].sort();
    for (const key of selected) {
      check(metadata.has(key), `selected stability key was not originally authenticated: ${key}`);
      await read(key, { fresh: true });
    }
    return { checked_keys: selected.length };
  }
  async function verifyCachedObjects(keys) {
    const selected = [...new Set(keys)].sort();
    for (const key of selected) {
      const pinned = inventory.get(key);
      check(pinned, `selected source object was not originally authenticated: ${key}`);
      const body = await fs.readFile(path.join(cacheDir, pinned.sha256));
      check(body.length === pinned.byte_size && sha256Hex(body) === pinned.sha256,
        `cached selected source bytes failed their original identity: ${key}`);
    }
    return { verified_keys: selected.length };
  }
  async function readCurrentDigest(key) {
    admit(key);
    const body = await fetchBytes(key, limits.metadataBytes);
    return { key, sha256: sha256Hex(body), byte_size: body.length };
  }
  return { read, json, checkSelectedStability, verifyCachedObjects,
    readCurrentDigest, deadline, inventory, metadata, metrics, sourceRoot };
}
