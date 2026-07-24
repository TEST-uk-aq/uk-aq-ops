type RpcError = { message: string };

export type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

function normalizeUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}/rest/v1`;
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error_description", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  if (typeof payload === "string" && payload.trim()) return payload;
  return `HTTP ${status}`;
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class SupabaseRpcClient {
  constructor(
    private readonly baseUrl: string,
    private readonly privilegedKey: string,
    private readonly schema: string,
    private readonly retries: number,
  ) {}

  async post<T>(
    rpcName: string,
    args: Record<string, unknown>,
  ): Promise<RpcResult<T>> {
    const url = `${normalizeUrl(this.baseUrl)}/rpc/${rpcName}`;
    const headers: Record<string, string> = {
      apikey: this.privilegedKey,
      Authorization: `Bearer ${this.privilegedKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Profile": this.schema,
      "Content-Profile": this.schema,
      "x-ukaq-egress-caller": "uk_aq_who_2021_daily_github_actions",
    };

    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        });
        const contentType = (response.headers.get("content-type") || "")
          .toLowerCase();
        const payload = contentType.includes("application/json")
          ? await response.json().catch(() => null)
          : await response.text().catch(() => null);

        if (response.ok) return { data: payload as T, error: null };
        if (attempt < this.retries && isRetryable(response.status)) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(5000, attempt * 1000))
          );
          continue;
        }
        return {
          data: null,
          error: { message: errorMessage(payload, response.status) },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < this.retries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(5000, attempt * 1000))
          );
          continue;
        }
        return { data: null, error: { message } };
      }
    }
    return { data: null, error: { message: "unknown_rpc_error" } };
  }
}
