import { AccountsSourceError, accountsReadStage, logAccountsFailure, readAccountsJson } from '../lib/accounts_diagnostics';
import { AccountsError, authorizeAccountsRequest } from '../lib/accounts_auth';
import type { AccountsAccessContext } from '../lib/accounts_auth';
import { readAccountsSubscriptions, writeAccountsSubscription } from '../lib/direct';
import type { WorkerEnv } from '../lib/upstream';

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_FIELDS = ['id', 'email', 'status', 'delivery_mode', 'daily_time_local', 'timezone',
  'confirmed_at', 'created_at', 'updated_at', 'unsubscribed_at', 'blocked_at', 'block_reason', 'consent_text_version',
  'mode_since_at', 'confirmation_last_sent_at', 'confirmed'] as const;
const DELIVERY_FIELDS = ['id', 'subscription_id', 'delivery_mode', 'state', 'created_at', 'sent_at',
  'failed_at', 'attempt_count', 'selected_transport', 'attempt_transport', 'retry_hold', 'error_class'] as const;
const OUTBOX_FIELDS = ['id', 'work_type', 'state', 'created_at', 'queued_at', 'attempt_count', 'error_class'] as const;
const STATUSES = ['pending', 'active', 'unsubscribed', 'blocked'];
const MODES = ['confirmation', 'immediate', 'daily'];
const STATES = ['pending', 'sending', 'accepted', 'temporary_failure', 'permanent_failure', 'unknown', 'cancelled'];
const TRANSPORTS = [null, 'cloudflare_xoauth2', 'pro_app_password'];
const ERRORS = [null, 'digest_size_requires_operator', 'stale_smtp_claim', 'stale_pre_submission_claim',
  'temporary_failure', 'permanent_failure', 'unknown', 'subscription_service_unavailable', 'work_retry_required', 'unavailable'];

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 405 ? { Allow: 'GET, POST' } : {}),
  } });
}

export function isAccountsPath(path: string): boolean {
  return path === '/api/accounts' || path.startsWith('/api/accounts/');
}

function badQuery(): never {
  throw new AccountsError('INVALID_QUERY', 'Invalid Accounts query parameters', 400);
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid read response');
  return value as Json;
}

function project(value: unknown, fields: readonly string[]): Json {
  const row = object(value);
  return Object.fromEntries(fields.map(field => {
    const item = row[field] ?? null;
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' &&
        !(typeof item === 'number' && Number.isSafeInteger(item))) throw new Error('Invalid read field');
    // Legacy block reasons may contain line breaks; JSON and the escaped UI keep them text.
    if (typeof item === 'string' && (item.length > 512 ||
        (field !== 'block_reason' && /[\x00-\x1f\x7f]/.test(item)))) throw new Error('Invalid read field');
    return [field, item];
  }));
}

function subscriptionRecord(value: unknown): Json {
  const row = project(value, SUBSCRIPTION_FIELDS);
  if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.email !== 'string' || row.email.length > 254 ||
      !STATUSES.includes(String(row.status)) || !['immediate', 'daily'].includes(String(row.delivery_mode)) ||
      typeof row.confirmed !== 'boolean') throw new Error('Invalid subscription');
  return row;
}

function integer(query: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) badQuery();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) badQuery();
  return value;
}

function validateKeys(query: URLSearchParams, allowed: readonly string[]): void {
  query.forEach((_, key) => { if (!allowed.includes(key) || query.getAll(key).length !== 1) badQuery(); });
}

function validateRequestQuery(url: URL): void {
  if (url.pathname.length + url.search.length > 4096) {
    throw new AccountsError('REQUEST_TOO_LARGE', 'Accounts request is too large', 414);
  }
  if (!url.search) return;
  for (const part of url.search.slice(1).split('&')) {
    if (!part.includes('=')) badQuery();
    try {
      if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(part.replace(/\+/g, ' ')))) badQuery();
    } catch { badQuery(); }
  }
}

function choice(query: URLSearchParams, key: string, fallback: string, values: readonly string[]): string {
  const value = query.get(key) ?? fallback;
  if (!values.includes(value)) badQuery();
  return value;
}

function page(query: URLSearchParams): { limit: number; offset: number } {
  return { limit: integer(query, 'limit', 25, 1, 100), offset: integer(query, 'offset', 0, 0, 10000) };
}

function pagination(value: unknown, expected: { limit: number; offset: number }): Json {
  const data = object(value);
  if (data.limit !== expected.limit || data.offset !== expected.offset || typeof data.has_more !== 'boolean') {
    throw new Error('Invalid pagination');
  }
  return { ...expected, has_more: data.has_more };
}

function rows(value: unknown, limit: number, fields: readonly string[]): Json[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid bounded read');
  return value.map(item => project(item, fields));
}

function assertSubscriptionSource(env: WorkerEnv): void {
  try {
    const base = new URL(String(env.SUPABASE_URL || '').trim());
    const schema = String(env.UK_AQ_PUBLIC_SCHEMA || 'uk_aq_public').trim();
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' ||
        base.search || base.hash || !String(env.SB_SECRET_KEY || '').trim() || !/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error();
    }
  } catch {
    logAccountsFailure('SUPABASE_CONFIGURATION');
    throw new AccountsError('ACCOUNTS_SOURCE_NOT_CONFIGURED', 'Accounts IngestDB environment configuration is missing or invalid', 503);
  }
}

async function subscriptions(url: URL, env: WorkerEnv): Promise<Response> {
  assertSubscriptionSource(env);
  const query = url.searchParams;
  const detail = /^\/api\/accounts\/subscriptions\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    if (!UUID.test(detail[1]) || query.size) badQuery();
    const result = object(await readAccountsSubscriptions(env, { subscription_id: detail[1].toLowerCase() }));
    if (result.subscription === null) return reply({ subscription: null }, 404);
    const subscription = subscriptionRecord(result.subscription);
    if (String(subscription.id).toLowerCase() !== detail[1].toLowerCase()) throw new Error('Invalid subscription identity');
    return reply({ subscription });
  }
  if (url.pathname !== '/api/accounts/subscriptions') {
    throw new AccountsError('NOT_FOUND', 'Accounts API route not found', 404);
  }
  validateKeys(query, ['search', 'status', 'delivery_mode', 'sort', 'direction', 'limit', 'offset']);
  const search = (query.get('search') || '').trim().toLowerCase();
  if (search.length > 254 || /[\x00-\x1f\x7f]/.test(search)) badQuery();
  const paging = page(query);
  const result = object(await readAccountsSubscriptions(env, { ...paging, search,
    status: choice(query, 'status', '', ['', 'pending', 'active', 'unsubscribed', 'blocked']),
    delivery_mode: choice(query, 'delivery_mode', '', ['', 'immediate', 'daily']),
    sort: choice(query, 'sort', 'created_at', ['email', 'created_at', 'updated_at', 'status']),
    direction: choice(query, 'direction', 'desc', ['asc', 'desc']),
  }));
  const sourceCounts = object(result.counts);
  const counts: Json = {};
  for (const status of ['pending', 'active', 'unsubscribed', 'blocked']) {
    const count = sourceCounts[status];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid counts');
    counts[status] = count;
  }
  return reply({ items: rows(result.items, paging.limit, SUBSCRIPTION_FIELDS).map(subscriptionRecord), counts,
    pagination: pagination(result.pagination, paging) });
}

async function delivery(url: URL, env: WorkerEnv): Promise<Response> {
  const query = url.searchParams;
  validateKeys(query, ['subscription_id', 'limit', 'offset', 'days']);
  const paging = page(query);
  const days = integer(query, 'days', 7, 1, 30);
  const subscription = query.get('subscription_id');
  if (subscription !== null && !UUID.test(subscription)) badQuery();
  let target: URL;
  const token = String(env.UK_AQ_MEDIA_ADMIN_TOKEN || '').trim();
  try {
    const base = new URL(String(env.UK_AQ_MEDIA_ADMIN_URL || '').trim());
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' ||
        base.search || base.hash || !token || token.length > 4096) throw new Error();
    target = new URL('/admin/news-email/delivery', base);
  } catch {
    logAccountsFailure('MEDIA_ADMIN_CONFIGURATION');
    throw new AccountsError('EMAIL_DELIVERY_UNAVAILABLE', 'Email Delivery read access is not configured', 503);
  }
  target.searchParams.set('limit', String(paging.limit));
  target.searchParams.set('offset', String(paging.offset));
  target.searchParams.set('days', String(days));
  if (subscription) target.searchParams.set('subscription_id', subscription.toLowerCase());
  const request = await accountsReadStage('MEDIA_ADMIN_REQUEST_CONSTRUCTION', () => new Request(target, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
  }));
  const response = await accountsReadStage('MEDIA_ADMIN_FETCH', () => fetch(request));
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AccountsSourceError('MEDIA_ADMIN_HTTP_REJECTED', response.status);
  }
  const result = object(await readAccountsJson(response, 'MEDIA_ADMIN'));
  if (result.available !== true || result.window_days !== days || !Array.isArray(result.summary) || result.summary.length > 24) {
    throw new Error('Invalid delivery read');
  }
  const summary = result.summary.map(row => project(row, ['delivery_mode', 'state', 'count']));
  const deliveries = rows(result.deliveries, paging.limit, DELIVERY_FIELDS);
  const outbox = rows(result.outbox, paging.limit, OUTBOX_FIELDS);
  for (const row of summary) {
    if (!MODES.includes(String(row.delivery_mode)) || ![...STATES, 'held'].includes(String(row.state)) ||
        typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error('Invalid summary');
  }
  for (const row of deliveries) {
    if (!MODES.includes(String(row.delivery_mode)) || !STATES.includes(String(row.state)) ||
        !TRANSPORTS.includes(row.selected_transport as string | null) || !TRANSPORTS.includes(row.attempt_transport as string | null) ||
        !ERRORS.includes(row.error_class as string | null) || typeof row.retry_hold !== 'boolean' ||
        typeof row.attempt_count !== 'number' || row.attempt_count < 0 || typeof row.subscription_id !== 'string' ||
        !UUID.test(row.subscription_id) || (subscription && row.subscription_id.toLowerCase() !== subscription.toLowerCase())) {
      throw new Error('Invalid delivery');
    }
  }
  for (const row of outbox) {
    if (!['confirmation_email', 'approval_dispatch', 'immediate_delivery', 'daily_digest', 'daily_scan', 'confirmation_scan'].includes(String(row.work_type)) ||
        !['pending', 'queued', 'completed'].includes(String(row.state)) || !ERRORS.includes(row.error_class as string | null) ||
        typeof row.attempt_count !== 'number' || row.attempt_count < 0) throw new Error('Invalid outbox');
  }
  return reply({ available: true, window_days: days,
    summary, deliveries, outbox, pagination: pagination(result.pagination, paging) });
}


async function mutateSubscription(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  const route = /^\/api\/accounts\/subscriptions\/([^/]+)\/actions$/.exec(url.pathname);
  if (!route) throw new AccountsError('NOT_FOUND', 'Accounts API route not found', 404);
  if (!UUID.test(route[1]) || url.search) badQuery();
  // A custom header + JSON prohibits simple cross-origin form requests; no CORS preflight is allowed.
  if (request.headers.get('X-UKAQ-Accounts-Action') !== '1' ||
      request.headers.get('Origin') !== url.origin ||
      ![null, 'same-origin'].includes(request.headers.get('Sec-Fetch-Site'))) {
    throw new AccountsError('FORBIDDEN', 'Same-origin administrative action required', 403);
  }
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') badQuery();
  if (Number(request.headers.get('Content-Length')) > 4096 || !request.body) badQuery();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); badQuery(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: Json;
  try { body = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { badQuery(); }
  const action = body.action;
  if (typeof action !== 'string' || !['edit','block','unblock','unsubscribe','delete'].includes(action) ||
      body.confirmed !== true || typeof body.expected_updated_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.expected_updated_at) ||
      !Number.isFinite(Date.parse(body.expected_updated_at))) badQuery();
  const allowed = ['action','confirmed','expected_updated_at',
    ...(action === 'edit' ? ['delivery_mode','daily_time_local'] : action === 'block' ? ['reason'] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key))) badQuery();
  if (action === 'edit' && (!['immediate','daily'].includes(String(body.delivery_mode)) ||
      typeof body.daily_time_local !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.daily_time_local))) badQuery();
  if (action === 'block' && (typeof body.reason !== 'string' || !body.reason.trim() ||
      body.reason.length > 200 || /[\x00-\x1f\x7f]/.test(body.reason))) badQuery();
  assertSubscriptionSource(env);
  const id = route[1].toLowerCase();
  const result = object(await writeAccountsSubscription(env, { ...body, subscription_id: id }));
  if (result.ok === false && result.code === 'NOT_FOUND') return reply({ error: {
    code: 'NOT_FOUND', message: 'Subscription no longer exists' } }, 404);
  if (result.ok === false && result.code === 'CONFLICT') return reply({ error: {
    code: 'CONFLICT', message: 'Subscription changed or action is unavailable; refresh detail' } }, 409);
  if (result.ok !== true || result.subscription_id !== id ||
      (action === 'delete' && result.deleted !== true)) throw new Error('Invalid action receipt');
  return reply({ ok: true, subscription_id: id, ...(action === 'delete' ? { deleted: true } : {}) });
}

export async function handleAccountsRoute(request: Request, env: WorkerEnv, ctx: AccountsAccessContext): Promise<Response> {
  try {
    await authorizeAccountsRequest(ctx);
    const url = new URL(request.url);
    validateRequestQuery(url);
    if (request.method === 'POST') return await mutateSubscription(request, url, env);
    if (request.method !== 'GET') throw new AccountsError('METHOD_NOT_ALLOWED', 'Unsupported Accounts method', 405);
    if (request.body) badQuery();
    if (url.pathname === '/api/accounts/email-delivery') {
      return await delivery(url, env).catch(error => {
        if (error instanceof AccountsError || error instanceof AccountsSourceError) throw error;
        throw new AccountsSourceError('MEDIA_ADMIN_RESPONSE_VALIDATION');
      });
    }
    return await subscriptions(url, env);
  } catch (error) {
    if (error instanceof AccountsError) return reply({ error: { code: error.code, message: error.message } }, error.status);
    const diagnostic = error instanceof AccountsSourceError ? error.diagnostic : 'SUPABASE_RESPONSE_VALIDATION';
    logAccountsFailure(diagnostic, error instanceof AccountsSourceError ? error.upstreamStatus : undefined);
    if (diagnostic.startsWith('MEDIA_ADMIN_')) {
      return reply({ error: { code: 'EMAIL_DELIVERY_UNAVAILABLE',
        message: 'Authoritative Email Delivery reads are unavailable' } }, 503);
    }
    // Do not return/log upstream error text, raw request URLs, email searches or identity claims.
    return reply({ error: { code: 'ACCOUNTS_SOURCE_UNAVAILABLE',
      message: 'Accounts source unavailable; verify its environment configuration and required migrations' } }, 502);
  }
}
