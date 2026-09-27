import { errorEnvelope } from '../lib/http';
import type { WorkerEnv } from '../lib/upstream';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOCAL_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const BROWSER_IMAGE_CACHE_CONTROL = 'private, max-age=604800, immutable';
const EDGE_IMAGE_CACHE_CONTROL = 'public, max-age=2592000';
const ARTICLE_IMAGE_PATH = /^\/api\/media\/articles\/[1-9]\d*\/image$/;
const ARTICLE_LOCAL_IMAGE_PATH = /^\/api\/media\/articles\/[1-9]\d*\/local-image$/;
const LOCAL_IMAGE_VERSION = /^[a-f0-9]{64}$/;
const IMAGE_CACHE_HEADER = 'X-UK-AQ-Media-Image-Cache';

export type MediaExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

function mediaImageCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default;
}

const ROUTES: Array<{ pattern: RegExp; methods: ReadonlySet<string> }> = [
  { pattern: /^\/api\/media\/articles$/, methods: new Set(['GET', 'POST']) },
  { pattern: /^\/api\/media\/articles\/selectors$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/media\/articles\/lookup$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/bulk-approve$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/bulk-publish$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/image$/, methods: new Set(['GET']) },
  { pattern: ARTICLE_LOCAL_IMAGE_PATH, methods: new Set(['PUT', 'DELETE']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/publish$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/(approve|reject|hide|unhide)$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/author$/, methods: new Set(['PUT']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/published-at$/, methods: new Set(['PUT']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/display-title$/, methods: new Set(['PUT']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/display-title\/generate-ai$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/display-title\/(accept-ai|reject-ai)$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/guardian-image-refresh\/(preview|apply)$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/metadata\/preview$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/articles\/[1-9]\d*\/metadata\/apply$/, methods: new Set(['PUT']) },
  { pattern: /^\/api\/media\/bluesky\/settings$/, methods: new Set(['GET', 'PUT']) },
  { pattern: /^\/api\/media\/facebook\/settings$/, methods: new Set(['GET', 'PUT']) },
  { pattern: /^\/api\/media\/facebook\/connection-check$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/ai-usage$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/media\/runs$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/media\/runs\/gdelt$/, methods: new Set(['GET']) },
  { pattern: /^\/api\/media\/sources$/, methods: new Set(['GET', 'POST']) },
  { pattern: /^\/api\/media\/sources\/[a-z0-9]+(?:-[a-z0-9]+)*$/, methods: new Set(['PUT']) },
  { pattern: /^\/api\/media\/author-rules$/, methods: new Set(['POST']) },
  { pattern: /^\/api\/media\/author-rules\/[a-z0-9]+:[a-z0-9]+(?:-[a-z0-9]+)*$/, methods: new Set(['PUT']) },
];

export function isMediaRoute(pathname: string): boolean {
  return ROUTES.some(route => route.pattern.test(pathname));
}

function mediaBaseUrl(env: WorkerEnv): string | null {
  const raw = String(env.UK_AQ_MEDIA_ADMIN_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function browserImageResponse(response: Response, cacheStatus: 'HIT' | 'MISS'): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', BROWSER_IMAGE_CACHE_CONTROL);
  headers.set(IMAGE_CACHE_HEADER, cacheStatus);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) return null;
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('Media request body is too large'); } catch { /* best effort */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function handleMediaRoute(request: Request, env: WorkerEnv,
  ctx: MediaExecutionContext): Promise<Response> {
  const incoming = new URL(request.url);
  const route = ROUTES.find(candidate => candidate.pattern.test(incoming.pathname));
  if (!route) return errorEnvelope('NOT_FOUND', 'Media API route not found', 404);
  const method = request.method.toUpperCase();
  if (!route.methods.has(method)) {
    return errorEnvelope('METHOD_NOT_ALLOWED', 'Method not supported for this Media route', 405);
  }
  const base = mediaBaseUrl(env);
  const token = String(env.UK_AQ_MEDIA_ADMIN_TOKEN || '').trim();
  if (!base || !token) {
    return errorEnvelope('MEDIA_ADMIN_NOT_CONFIGURED', 'Media admin is unavailable', 503);
  }
  const imageVersion = (incoming.searchParams.get('v') || '').trim();
  const hasImageVersion = method === 'GET' && ARTICLE_IMAGE_PATH.test(incoming.pathname)
    && imageVersion.length > 0;
  const isLocalImage = hasImageVersion && LOCAL_IMAGE_VERSION.test(imageVersion);
  const isVersionedRemoteImage = hasImageVersion && !isLocalImage;
  let imageCacheKey: Request | null = null;
  if (isVersionedRemoteImage) {
    const cacheUrl = new URL(incoming.origin + incoming.pathname);
    cacheUrl.searchParams.set('v', imageVersion);
    imageCacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    try {
      const cached = await mediaImageCache().match(imageCacheKey);
      if (cached) return browserImageResponse(cached, 'HIT');
    } catch {
      // Cache API availability must not prevent the authenticated upstream fetch.
    }
  }
  const explicitPaths: Record<string, string> = {
    '/api/media/articles/bulk-approve': '/admin/articles/bulk/approve',
    '/api/media/articles/bulk-publish': '/admin/articles/bulk/publish',
  };
  const upstreamPath = explicitPaths[incoming.pathname]
    || incoming.pathname.replace(/^\/api\/media/, '/admin');
  const upstreamUrl = new URL(`${base}${upstreamPath}`);
  incoming.searchParams.forEach((value, name) => {
    if (!(hasImageVersion && name === 'v')) {
      upstreamUrl.searchParams.append(name, value);
    }
  });
  const target = upstreamUrl.toString();
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: request.headers.get('Accept') || '*/*' });
  const contentType = request.headers.get('Content-Type');
  const contentLength = request.headers.get('Content-Length');
  const idempotency = request.headers.get('Idempotency-Key');
  const ifMatch = request.headers.get('If-Match');
  if (contentType) headers.set('Content-Type', contentType);
  if (contentLength) headers.set('Content-Length', contentLength);
  if (idempotency) headers.set('Idempotency-Key', idempotency);
  if (ifMatch) headers.set('If-Match', ifMatch);
  let body: ArrayBuffer | undefined;
  if (!['GET', 'HEAD'].includes(method)) {
    const maxBodyBytes = method === 'PUT' && ARTICLE_LOCAL_IMAGE_PATH.test(incoming.pathname)
      ? MAX_LOCAL_IMAGE_UPLOAD_BYTES : MAX_BODY_BYTES;
    const boundedBody = await readBoundedBody(request, maxBodyBytes);
    if (boundedBody === null) {
      return errorEnvelope('REQUEST_TOO_LARGE', 'Media request body is too large', 413);
    }
    body = boundedBody;
  }
  let upstream: Response;
  try { upstream = await fetch(target, { method, headers, body, redirect: 'manual' }); }
  catch { return errorEnvelope('MEDIA_ADMIN_UNREACHABLE', 'Media admin is unavailable', 502); }
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of ['Content-Type', 'Content-Length', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText,
    headers: responseHeaders });
  const upstreamContentType = (upstream.headers.get('Content-Type') || '').toLowerCase();
  const upstreamNoStore = /(?:^|,)\s*no-store(?:\s*(?:,|$))/.test(
    (upstream.headers.get('Cache-Control') || '').toLowerCase());
  if (imageCacheKey && upstream.ok && upstreamContentType.startsWith('image/') && !upstreamNoStore) {
    const cachedResponse = response.clone();
    cachedResponse.headers.set('Cache-Control', EDGE_IMAGE_CACHE_CONTROL);
    cachedResponse.headers.delete(IMAGE_CACHE_HEADER);
    ctx.waitUntil(mediaImageCache().put(imageCacheKey, cachedResponse).catch(() => undefined));
    return browserImageResponse(response, 'MISS');
  }
  if (ARTICLE_IMAGE_PATH.test(incoming.pathname)) response.headers.set(IMAGE_CACHE_HEADER, 'BYPASS');
  return response;
}
