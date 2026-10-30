import templates from '../lib/media_d1_queries.json';
import { AccountsError, authorizeAccountsRequest } from '../lib/accounts_auth';
import type { AccountsAccessContext } from '../lib/accounts_auth';
import type { WorkerEnv } from '../lib/upstream';

type Json = Record<string, any>;
type Config = { account: string; database: string; token: string; limits: Json; thresholds: Json };
type Entry = { at: number; data: Json };
const DAY = 86400000;
const TTL = 900000;
const STALE = 3600000;
const MAX_BYTES = 768 * 1024;
// Isolate-local only: no shared/browser cache and no persistent analytics store.
const cache = new Map<string, Entry>();
const attempts = new Map<string, number[]>();
const manualAttempts = new Map<string, number>();
const pending = new Map<string, Promise<Json>>();

class SourceError extends Error {
  constructor(public code: string, public staleSafe = false) { super(code); }
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('INVALID_ANALYTICS');
  return value as Json;
}
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
function positive(value: unknown): number | null {
  const raw = String(value || '');
  return /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}
function day(value: number): string { return new Date(value).toISOString().slice(0, 10); }
function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 405 ? { Allow: 'GET' } : {}),
  } });
}
// Common Cloudflare D1 Free-plan limits and dashboard warning policy.
// These product defaults are independent of the deployment's account identity.
const DEFAULTS = { DAILY_READ_LIMIT: 5000000, DAILY_WRITE_LIMIT: 100000,
  WARNING_PERCENT: 75, CRITICAL_PERCENT: 90 };
function configuration(env: WorkerEnv): Config {
  const account = String(env.UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID || '').trim();
  const database = String(env.UK_AQ_MEDIA_CFLARE_D1DB_ID || '').trim();
  const token = String(env.UK_AQ_MEDIA_D1_ANALYTICS_TOKEN || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(account) || !token || token.length > 4096 || /\s/.test(token)) {
    throw new SourceError('NOT_CONFIGURED');
  }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database)) throw new SourceError('DATABASE_NOT_CONFIGURED');
  const override = (name: keyof typeof DEFAULTS): number => {
    const value = env[`UK_AQ_MEDIA_D1_${name}` as keyof WorkerEnv];
    if (value === undefined) return DEFAULTS[name];
    const parsed = positive(value);
    if (parsed === null) throw new SourceError('INVALID_ALLOWANCES');
    return parsed;
  };
  const limits = { rows_read: override('DAILY_READ_LIMIT'), rows_written: override('DAILY_WRITE_LIMIT') };
  const thresholds = { warning: override('WARNING_PERCENT'), critical: override('CRITICAL_PERCENT') };
  if (thresholds.warning >= thresholds.critical || thresholds.critical > 100) throw new SourceError('INVALID_ALLOWANCES');
  return { account, database, token, limits, thresholds };
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function graphql(config: Config, query: string, variables: Json): Promise<Json> {
  let response: Response;
  try {
    response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { account: config.account, ...variables } }),
      signal: AbortSignal.timeout(12000) });
  } catch { throw new SourceError('ANALYTICS_UNAVAILABLE', true); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(response.status === 401 || response.status === 403 ? 'ANALYTICS_ACCESS_DENIED' :
      'ANALYTICS_UNAVAILABLE', response.status >= 500);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError('INVALID_ANALYTICS');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new SourceError('INVALID_ANALYTICS'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: Json;
  try { payload = object(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new SourceError('INVALID_ANALYTICS'); }
  // Never return/log provider error bodies; even a partial GraphQL error fails closed.
  if (payload.errors?.length) throw new SourceError('ANALYTICS_REJECTED');
  const accounts = payload.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new SourceError('ANALYTICS_ACCESS_DENIED');
  return object(accounts[0]);
}
function settings(value: unknown, fields: string[]): Json {
  const info = object(value);
  if (info.enabled !== true || !Array.isArray(info.availableFields) ||
      fields.some(field => !info.availableFields.includes(field)) ||
      !positive(info.maxDuration) || !positive(info.notOlderThan) || !positive(info.maxPageSize)) {
    throw new SourceError('DATASET_UNAVAILABLE');
  }
  return info;
}
async function retrieve(config: Config, mode: string, dates: string[], selected: string, now: number): Promise<Json> {
  const info = object((await graphql(config, templates.settings, {})).settings);
  const dataset = mode === 'daily' ? 'daily' : 'queries';
  const limits = settings(info[dataset], mode === 'daily' ? ['dimensions_date', 'sum_rowsRead', 'sum_rowsWritten'] :
    ['dimensions_query', 'count', 'sum_rowsRead']);
  const oldest = Math.ceil((now - Number(limits.notOlderThan) * 1000) / DAY) * DAY;
  if (mode === 'queries') {
    const start = Date.parse(`${selected}T00:00:00Z`);
    if (start < oldest) throw new SourceError('OUTSIDE_RETENTION');
    if (Number(limits.maxDuration) < 86400 || Number(limits.maxPageSize) < 5) throw new SourceError('UNSUPPORTED_WINDOW');
    const fields = ['rowsRead', ...(limits.availableFields.includes('sum_rowsWritten') ? ['rowsWritten'] : [])];
    const result = await graphql(config, templates.queries.replace('METRICS', fields.join(' ')), {
      database: config.database, start: new Date(start).toISOString(), end: new Date(Math.min(start + DAY, now)).toISOString(),
    });
    if (!Array.isArray(result.queries) || result.queries.length > 5) throw new SourceError('INVALID_ANALYTICS');
    const rows = await Promise.all(result.queries.map(async (raw: unknown) => {
      const row = object(raw), sum = object(row.sum), query = object(row.dimensions).query;
      const count = numeric(row.count), reads = numeric(sum.rowsRead);
      if (typeof query !== 'string' || query.length > 100000 || reads === null || count === null) throw new SourceError('INVALID_ANALYTICS');
      // An opaque description is deliberately safer than attempting a complete SQL parser.
      // Hash the provider group verbatim, so distinct groups cannot acquire the
      // same label through lossy redaction. The digest is the only preview.
      const fingerprint = (await digest(query)).slice(0, 20);
      const operation = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|PRAGMA)\b/i.exec(query)?.[1].toUpperCase() || 'SQL';
      return { description: `${operation} · query ${fingerprint}`, fingerprint, executions: count,
        rows_read: reads, average_rows_read: count > 0 ? reads / count : null, rows_written: numeric(sum.rowsWritten) };
    }));
    return { rows: rows.sort((a, b) => b.rows_read - a.rows_read), scope: 'media_database' };
  }
  const fields = ['rowsRead', 'rowsWritten', ...['readQueries', 'writeQueries'].filter(field => limits.availableFields.includes(`sum_${field}`))];
  const eligible = dates.filter(date => Date.parse(`${date}T00:00:00Z`) >= oldest);
  const chunkSize = Math.min(31, Math.floor(Number(limits.maxDuration) / 86400), Number(limits.maxPageSize));
  if (chunkSize < 1 || Math.ceil(eligible.length / chunkSize) > 12) throw new SourceError('UNSUPPORTED_WINDOW');
  const byDay = new Map<string, Json>();
  for (let index = 0; index < eligible.length; index += chunkSize) {
    const chunk = eligible.slice(index, index + chunkSize);
    const query = templates.daily.replace('LIMIT', String(chunk.length)).replace('METRICS', fields.join(' '));
    const result = await graphql(config, query, { start: chunk[0], end: chunk[chunk.length - 1] });
    if (!Array.isArray(result.daily) || result.daily.length > chunk.length) throw new SourceError('INVALID_ANALYTICS');
    for (const raw of result.daily) {
      const row = object(raw), date = object(row.dimensions).date, sum = object(row.sum);
      if (!chunk.includes(date) || byDay.has(date) || numeric(sum.rowsRead) === null || numeric(sum.rowsWritten) === null) {
        throw new SourceError('INVALID_ANALYTICS');
      }
      byDay.set(date, { rows_read: numeric(sum.rowsRead), rows_written: numeric(sum.rowsWritten),
        read_queries: numeric(sum.readQueries), write_queries: numeric(sum.writeQueries) });
    }
  }
  return { scope: 'account', retention_start: day(oldest), rows: dates.map(date => ({ date, partial: date === dates[dates.length - 1],
    status: byDay.has(date) ? 'available' : Date.parse(`${date}T00:00:00Z`) < oldest ? 'outside_retention' : 'missing',
    rows_read: null, rows_written: null, read_queries: null, write_queries: null, ...byDay.get(date) })) };
}
async function usageData(env: WorkerEnv, mode: string, dates: string[], selected: string, refresh: boolean): Promise<Json> {
  let config: Config;
  try { config = configuration(env); }
  catch (error) { return { status: 'unavailable', error: error instanceof SourceError ? error.code : 'NOT_CONFIGURED',
    daily_limits: null, thresholds: null, retrieved_at: null, rows: [] }; }
  const now = Date.now();
  const identity = await digest(JSON.stringify([config.account, config.database, config.token]));
  const key = `${identity}:${mode}:${dates[0]}:${dates[dates.length - 1]}:${mode === 'queries' ? selected : ''}`;
  const gate = mode;
  const entry = cache.get(key);
  const base = { daily_limits: config.limits, thresholds: config.thresholds };
  if (!refresh && entry && now - entry.at < TTL) return { ...base, ...entry.data, status: 'cached', error: null };
  if (pending.has(key)) return { ...base, ...await pending.get(key)! };
  const recentAttempts = (attempts.get(gate) || []).filter(at => now - at < 60000);
  if (recentAttempts.length >= 4 || (refresh && now - (manualAttempts.get(gate) || 0) < 60000) || pending.has(gate)) {
    return { ...base, ...(entry && now - entry.at <= STALE ? entry.data : { rows: [], retrieved_at: null }),
      status: entry && now - entry.at <= STALE ? (now - entry.at < TTL ? 'cached' : 'stale') : 'unavailable', error: 'REFRESH_RATE_LIMITED' };
  }
  attempts.set(gate, [...recentAttempts, now]);
  if (refresh) manualAttempts.set(gate, now);
  const job = (async (): Promise<Json> => {
    try {
      const data = { ...await retrieve(config, mode, dates, selected, now), retrieved_at: new Date().toISOString() };
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), data });
      return { ...data, status: 'fresh', error: null };
    } catch (error) {
      const failure = error instanceof SourceError ? error : new SourceError('ANALYTICS_UNAVAILABLE');
      if (entry && failure.staleSafe && now - entry.at <= STALE) return { ...entry.data, status: 'stale', error: failure.code };
      // Known access/schema failures must not leave another range/metric cached
      // under the same credentials and later reported as a successful retrieval.
      for (const cachedKey of cache.keys()) if (cachedKey.startsWith(`${identity}:`)) cache.delete(cachedKey);
      return { status: 'unavailable', error: failure.code, retrieved_at: null, rows: [] };
    }
  })();
  pending.set(key, job); pending.set(gate, job);
  try { return { ...base, ...await job }; }
  finally { pending.delete(key); pending.delete(gate); }
}
export async function handleMediaD1Usage(request: Request, env: WorkerEnv, ctx: AccountsAccessContext): Promise<Response> {
  try {
    await authorizeAccountsRequest(ctx);
    if (request.method !== 'GET') return reply({ error: { message: 'Only GET is supported' } }, 405);
    const url = new URL(request.url), query = url.searchParams;
    if (url.search.length > 256 || /%(?![0-9a-f]{2})/i.test(url.search) ||
        (url.search && url.search.slice(1).split('&').some(part => !part.includes('=')))) throw new Error('query');
    query.forEach((_, key) => { if (!['days', 'day', 'view', 'refresh'].includes(key) || query.getAll(key).length !== 1) throw new Error('query'); });
    const days = query.get('days') ?? '7', mode = query.get('view') ?? 'daily';
    const refresh = query.get('refresh') ?? '0';
    if (!['7', '30', '90'].includes(days) || !['daily', 'queries'].includes(mode) || !['0', '1'].includes(refresh) ||
        (mode === 'daily' && query.has('day'))) throw new Error('query');
    const today = Math.floor(Date.now() / DAY) * DAY;
    const dates = Array.from({ length: Number(days) }, (_, index) => day(today - (Number(days) - index - 1) * DAY));
    const selected = query.get('day') ?? dates[dates.length - 1];
    if (!dates.includes(selected)) throw new Error('query');
    const usage = await usageData(env, mode, dates, selected, refresh === '1');
    return reply({ view: mode, days: Number(days), dates, selected_day: selected, today: day(today), usage });
  } catch (error) {
    if (error instanceof AccountsError) return reply({ error: { code: error.code, message: error.message } }, error.status);
    return reply({ error: { code: 'INVALID_QUERY', message: 'Invalid D1 Usage parameters' } }, 400);
  }
}
