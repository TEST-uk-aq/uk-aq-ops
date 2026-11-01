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
const RETRY_DELAYS_MS = [1000, 3000], STDERR_BYTES = 8192;

function classifyRcloneFailure(code, diagnostic) {
  // Only these fixed categories escape the transport. Never attach upstream
  // text, command arguments or spawn errors to a reportable Error.
  const failure = (category, retryable = false) => ({ category, retryable });
  // Known non-retryable exits take precedence over transient-looking stderr.
  if (code === 2) return failure('syntax_or_usage');
  if (code === 6) return failure('no_retry');
  if (code === 9) return failure('no_files_transferred');
  if (/checksum.*(?:mismatch|differ)|(?:hash|size).*mismatch|corrupt(?:ion|ed)?|inconsistent (?:source|bytes)/i.test(diagnostic))
    return failure('integrity_failure');
  if (/context cancel(?:led|ed)|operation cancel(?:led|ed)|interrupted|signal received/i.test(diagnostic))
    return failure('interrupted');
  if (/out of memory|cannot allocate memory|no space left on device|too many open files|(?:max(?:imum)? (?:transfer|duration)|quota).*(?:limit|exceed|reached)/i.test(diagnostic))
    return failure('resource_limit');
  if (/invalid[_ ](?:access[_ ]token|grant|client|credentials|token)|invalid refresh token|expired[_ ](?:access[_ ])?token/i.test(diagnostic)
    || /unauthori[sz]ed|authentication|authorization|not_authenticated|access.denied|permission.denied|insufficient.scope|missing.scope|\b(?:401|403)\b/i.test(diagnostic))
    return failure('authentication_or_permission');
  if (/path\/(?:not_found|not_folder)|(?:object|file|directory) not found|no such file or directory|does not exist|doesn't exist|not a directory|is a directory|\b404\b/i.test(diagnostic))
    return failure('missing_object_or_path');
  if (/did(?:n't| not) find section|couldn't find backend|unknown (?:flag|command|backend)|failed to (?:load|read|parse) config/i.test(diagnostic)
    || /config file.*not found|invalid (?:configuration|config|argument)|syntax error|x509:|certificate.*(?:expired|unknown authority)/i.test(diagnostic))
    return failure('invalid_configuration');
  if (/path\/malformed_path|invalid (?:path|url)|malformed (?:path|url)|disallowed_name|\b400\b/i.test(diagnostic))
    return failure('permanent_path');
  if ([3, 4].includes(code)) return failure('missing_object_or_path');
  if ([8, 10, 11].includes(code)) return failure('resource_limit');
  if ([130, 137, 143].includes(code)) return failure('interrupted');
  if (code === 7) return failure('permanent_failure');
  if (/\b429\b|too.many.requests|rate.limit|retry.after/i.test(diagnostic))
    return failure('rate_limit', true);
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout/i.test(diagnostic))
    return failure('server_error', true);
  if (/timeout|timed out|deadline exceeded/i.test(diagnostic)) return failure('timeout', true);
  if (/connection (?:reset|refused|closed|aborted)|broken pipe|unexpected eof|network.*unreachable|no such host|temporary failure.*(?:name|resolution)|tls handshake|\bi\/o error\b/i.test(diagnostic))
    return failure('network_error', true);
  return failure('unclassified_exit', true);
}

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
  const recoveredObjects = new Set(), exhaustedObjects = new Set();
  const metrics = { read_commands: 0, dropbox_api_requests: null, source_bytes_read: 0,
    parquet_bytes_read: 0, metadata_bytes_read: 0, read_wall_ms: 0, read_cpu_ms: 0,
    cache_hits: 0, stability_read_commands: 0, transport_retry_attempts: 0,
    transport_retry_objects_recovered: 0, transport_retry_objects_exhausted: 0,
    transport_failure_counts: {} };
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
  function readBudget() {
    deadline();
    check(metrics.read_commands < limits.requests, 'Dropbox read-command budget exceeded');
    check(metrics.source_bytes_read < limits.sourceBytes, 'Dropbox source-byte budget exceeded');
  }
  async function fetchBytes(key, cap) {
    const begin = performance.now(), cpu = process.cpuUsage();
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        readBudget();
        const attemptCap = Math.min(cap, limits.sourceBytes - metrics.source_bytes_read);
        metrics.read_commands++;
        if (attempt > 1) metrics.transport_retry_attempts++;
        const result = await new Promise(resolve => {
          // A fresh buffer belongs only to this attempt. Failed stdout never
          // reaches hashing, cache writes or the authenticated inventory.
          const chunks = []; let size = 0, failure = null, diagnosticFailure = null;
          let diagnostic = Buffer.alloc(0), child;
          // Existing remote and RCLONE_CONFIG are inherited unchanged. rclone may
          // refresh its local OAuth token normally; no Dropbox content is written.
          try { child = spawn(rcloneBin, ['cat', joinTargetPath(sourceRoot, key),
            '--count', String(attemptCap + 1), '--retries', '1', '--low-level-retries', '1',
            '--contimeout', '15s', '--timeout', '30s', '--stats', '0', '--log-level', 'ERROR'],
          { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
          catch { resolve({ failure: { category: 'executable_start', retryable: false } }); return; }
          const timer = setTimeout(() => {
            const withinBudget = performance.now() - started < limits.wallSeconds * 1000;
            failure ||= { category: withinBudget ? 'timeout' : 'wall_time_limit', retryable: withinBudget };
            child.kill('SIGKILL');
          },
            Math.max(1, Math.min(45_000, limits.wallSeconds * 1000 - (performance.now() - started))));
          child.on('error', () => { failure = { category: 'executable_start', retryable: false }; });
          child.stderr.on('data', chunk => {
            // Scan a rolling, bounded window so a late permanent diagnostic is
            // still recognised. Drain the rest without retaining or logging it.
            for (let offset = 0; offset < chunk.length; offset += STDERR_BYTES / 2) {
              diagnostic = Buffer.concat([diagnostic.subarray(-STDERR_BYTES / 2),
                chunk.subarray(offset, offset + STDERR_BYTES / 2)]);
              const classified = classifyRcloneFailure(null, diagnostic.toString('utf8'));
              if (classified.category !== 'unclassified_exit' && (!diagnosticFailure || diagnosticFailure.retryable))
                diagnosticFailure = classified;
            }
          });
          const streamError = () => {
            failure ||= { category: 'local_stream_error', retryable: false }; child.kill('SIGKILL');
          };
          child.stdout.on('error', streamError); child.stderr.on('error', streamError);
          child.stdout.on('data', chunk => {
            size += chunk.length; metrics.source_bytes_read += chunk.length;
            metrics[key.endsWith('.parquet') ? 'parquet_bytes_read' : 'metadata_bytes_read'] += chunk.length;
            if (size > attemptCap) { failure = { category: 'byte_limit', retryable: false }; child.kill('SIGKILL'); }
            else if (!failure) chunks.push(chunk);
          });
          child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (signal && (!failure || signal !== 'SIGKILL')) failure = { category: 'interrupted', retryable: false };
            if (code !== 0) {
              const exitFailure = classifyRcloneFailure(code, '');
              if (!failure || (failure.retryable && !exitFailure.retryable)) failure = exitFailure;
            }
            if (failure?.retryable && diagnosticFailure) failure = diagnosticFailure;
            diagnostic = Buffer.alloc(0);
            if (failure) {
              chunks.length = 0;
              resolve({ failure, invocationFatal: ['authentication_or_permission', 'invalid_configuration',
                'resource_limit', 'interrupted', 'syntax_or_usage'].includes(diagnosticFailure?.category) });
            }
            else resolve({ body: Buffer.concat(chunks) });
          });
        });
        deadline();
        if (!result.failure) {
          if (attempt > 1) {
            recoveredObjects.add(key); metrics.transport_retry_objects_recovered = recoveredObjects.size;
          }
          return result.body;
        }
        const { category, retryable } = result.failure;
        metrics.transport_failure_counts[category] = (metrics.transport_failure_counts[category] || 0) + 1;
        if (!retryable || attempt === 3) {
          if (attempt === 3) {
            exhaustedObjects.add(key); metrics.transport_retry_objects_exhausted = exhaustedObjects.size;
          }
          const error = new Error(`Dropbox read failed (${category}; attempts ${attempt}/3): ${key}`);
          // An oversized object is scoped; exhausting the shared byte budget
          // must escape scope-continuation handlers before any further work.
          error.invocationFatal = result.invocationFatal
            || (category === 'byte_limit' && metrics.source_bytes_read >= limits.sourceBytes);
          throw error;
        }
        readBudget();
        const delay = RETRY_DELAYS_MS[attempt - 1] + Math.floor(Math.random() * 201);
        check(delay < limits.wallSeconds * 1000 - (performance.now() - started),
          'invocation wall-time limit prevents Dropbox retry backoff');
        await new Promise(resolve => setTimeout(resolve, delay));
        // The next iteration rechecks all budgets after the delay. Its previous
        // child has closed, so attempts cannot overlap or change source key.
      }
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
