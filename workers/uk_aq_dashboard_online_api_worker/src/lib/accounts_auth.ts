export class AccountsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

// Cloudflare's Workers runtime supplies this only when Access authenticated
// this invocation. Caller-supplied headers never populate the context.
export type AccountsAccessContext = {
  access?: {
    getIdentity(): Promise<{
      email?: string;
      user_uuid?: string;
      service_token_status?: boolean;
      service_token_id?: string;
    } | null | undefined>;
  };
};

export async function authorizeAccountsRequest(ctx: AccountsAccessContext): Promise<void> {
  if (!ctx.access) {
    throw new AccountsError('UNAUTHORIZED', 'A verified personal Access session is required', 401);
  }
  try {
    const identity = await ctx.access.getIdentity();
    if (!identity || identity.service_token_status === true || identity.service_token_id ||
        typeof identity.user_uuid !== 'string' || !identity.user_uuid.trim() || identity.user_uuid.length > 256 ||
        typeof identity.email !== 'string' || identity.email.length > 254 ||
        !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(identity.email.trim())) {
      throw new Error('No personal Access identity');
    }
  } catch {
    throw new AccountsError('UNAUTHORIZED', 'A verified personal Access session is required', 401);
  }
}
