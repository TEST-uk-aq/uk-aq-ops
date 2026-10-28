// Accounts-only failures: never retain upstream exception text, URLs or bodies.
export type AccountsDiagnosticCode =
  | 'SUPABASE_CONFIGURATION' | 'SUPABASE_REQUEST_CONSTRUCTION' | 'SUPABASE_FETCH'
  | 'SUPABASE_HTTP_REJECTED' | 'SUPABASE_RESPONSE_PARSE' | 'SUPABASE_RESPONSE_VALIDATION'
  | 'MEDIA_ADMIN_CONFIGURATION' | 'MEDIA_ADMIN_REQUEST_CONSTRUCTION' | 'MEDIA_ADMIN_FETCH'
  | 'MEDIA_ADMIN_HTTP_REJECTED' | 'MEDIA_ADMIN_RESPONSE_PARSE' | 'MEDIA_ADMIN_RESPONSE_VALIDATION';

export class AccountsSourceError extends Error {
  constructor(public readonly diagnostic: AccountsDiagnosticCode, public readonly upstreamStatus?: number) {
    super('Accounts source unavailable');
  }
}

export function logAccountsFailure(code: AccountsDiagnosticCode, upstreamStatus?: number): void {
  console.error(JSON.stringify({ event: 'accounts_read_failed', code,
    ...(typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
      ? { upstream_status: upstreamStatus } : {}),
  }));
}

export async function accountsReadStage<T>(code: AccountsDiagnosticCode, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AccountsSourceError) throw error;
    throw new AccountsSourceError(code);
  }
}

export async function readAccountsJson(response: Response, source: 'SUPABASE' | 'MEDIA_ADMIN'): Promise<unknown> {
  return accountsReadStage(source === 'SUPABASE' ? 'SUPABASE_RESPONSE_PARSE' : 'MEDIA_ADMIN_RESPONSE_PARSE', async () => {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(data));
  });
}
