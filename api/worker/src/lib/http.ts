export type ApiErrorBody = {
  ok: false;
  generatedAt: string;
  error: {
    code: string;
    message: string;
  };
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildJsonResponse(body: unknown, status = 200, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...CORS_HEADERS,
    },
  });
}

export function okEnvelope(data: unknown, status = 200): Response {
  return buildJsonResponse(
    {
      ok: true,
      generatedAt: nowIso(),
      data,
    },
    status,
  );
}

export function errorEnvelope(code: string, message: string, status = 500): Response {
  return buildJsonResponse(
    {
      ok: false,
      generatedAt: nowIso(),
      error: {
        code,
        message,
      },
    } satisfies ApiErrorBody,
    status,
  );
}

export function withCorsAndCacheControl(resp: Response, cacheControl: string): Response {
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", cacheControl);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export function withCorsAndNoStore(resp: Response): Response {
  return withCorsAndCacheControl(resp, "no-store");
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}
