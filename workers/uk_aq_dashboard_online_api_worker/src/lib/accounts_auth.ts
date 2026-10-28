import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { WorkerEnv } from './upstream';

export class AccountsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

// Only public signing keys are cached. Assertions, identity and subscriber data are not.
let signingKeys: { issuer: string; resolve: ReturnType<typeof createRemoteJWKSet> } | undefined;

export async function authorizeAccountsRequest(request: Request, env: WorkerEnv): Promise<void> {
  const team = String(env.DASHBOARD_ACCESS_TEAM_DOMAIN || '').trim();
  const audience = String(env.DASHBOARD_ACCESS_AUD || '').trim();
  const admins = String(env.DASHBOARD_ACCOUNTS_ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase());
  let issuer: string;
  try {
    const url = new URL(team);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(url.hostname) ||
        url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(audience) || !admins.length || admins.length > 100 ||
        admins.some(email => email.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) {
      throw new Error();
    }
    issuer = url.origin;
  } catch {
    throw new AccountsError('ACCOUNTS_AUTH_NOT_CONFIGURED', 'Accounts administrative authentication is not configured correctly', 503);
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (!assertion || assertion.length > 16384) {
    throw new AccountsError('UNAUTHORIZED', 'A verified administrative Access session is required', 401);
  }
  if (!signingKeys || signingKeys.issuer !== issuer) {
    signingKeys = { issuer, resolve: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 300000,
      [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error', cache: 'no-store' }),
    }) };
  }
  let email: string;
  try {
    const { payload } = await jwtVerify(assertion, signingKeys.resolve, {
      issuer, audience, algorithms: ['RS256'], clockTolerance: 0,
      requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub', 'email', 'type'],
    });
    const now = Date.now() / 1000;
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
        typeof payload.email !== 'string' || payload.email.length > 254 ||
        typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 5 ||
        typeof payload.exp !== 'number' || payload.exp <= payload.iat) throw new Error();
    email = payload.email.trim().toLowerCase();
  } catch {
    // Never return JOSE/upstream diagnostics: assertions and claim values are private.
    throw new AccountsError('UNAUTHORIZED', 'A verified administrative Access session is required', 401);
  }
  if (!admins.includes(email)) {
    throw new AccountsError('FORBIDDEN', 'This administrative identity cannot read subscriptions', 403);
  }
}
