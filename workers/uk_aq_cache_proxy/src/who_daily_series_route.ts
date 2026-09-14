import {
  addCorsHeaders,
  isOriginAllowed,
  parseAllowedOrigins,
  readSecret,
  resolveRequestOrigin,
} from "./index.ts";

export const WHO_DAILY_SERIES_API_PATH = "/api/aq/who-daily-series";

const RPC_NAME = "uk_aq_rpc_who_2021_daily_series";
const RPC_SCHEMA = "uk_aq_public";
const BROWSER_CACHE_CONTROL = "no-store";
const OBSERVATION_PROVENANCE_PATH = "/v1/daily-validation-provenance";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_QUERY_KEYS = new Set([
  "pollutant",
  "network_code",
  "selection",
  "timeseries_id",
]);
const CLASSIFICATIONS = new Set([
  "within_guideline",
  "above_guideline",
  "not_enough_data",
]);

export type WhoDailySeriesProxyEnv = {
  OBS_AQIDB_SUPABASE_URL?: unknown;
  OBS_AQIDB_SECRET_KEY?: unknown;
  UK_AQ_CACHE_ALLOWED_ORIGINS?: unknown;
  UK_AQ_OBSERVS_HISTORY_R2_API_URL?: unknown;
  UK_AQ_EDGE_UPSTREAM_SECRET?: unknown;
};

type ValidatedQuery = {
  selection: "random" | null;
  timeseriesId: number | null;
};

function jsonResponse(
  status: number,
  payload: unknown,
  requestMethod = "GET",
  requestOrigin: string | null = null,
  allowedOrigins: Set<string> = new Set(),
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": BROWSER_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
  });
  addCorsHeaders(headers, requestOrigin, allowedOrigins);
  return new Response(
    requestMethod === "HEAD" ? null : JSON.stringify(payload),
    {
      status,
      headers,
    },
  );
}

function jsonError(
  status: number,
  code: string,
  message: string,
  requestMethod = "GET",
  requestOrigin: string | null = null,
  allowedOrigins: Set<string> = new Set(),
): Response {
  return jsonResponse(
    status,
    { ok: false, error: code, message },
    requestMethod,
    requestOrigin,
    allowedOrigins,
  );
}

function isValidUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function addUtcDays(dayUtc: string, amount: number): string {
  const date = new Date(`${dayUtc}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validateQuery(
  url: URL,
): { ok: true; value: ValidatedQuery } | { ok: false; message: string } {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      return { ok: false, message: `Unsupported query parameter: ${key}` };
    }
    if (url.searchParams.getAll(key).length !== 1) {
      return { ok: false, message: `Query parameter must appear once: ${key}` };
    }
  }

  if (url.searchParams.get("pollutant") !== "pm25") {
    return { ok: false, message: "pollutant must be pm25" };
  }
  if (url.searchParams.get("network_code") !== "gov_uk_aurn") {
    return { ok: false, message: "network_code must be gov_uk_aurn" };
  }

  const selectionText = url.searchParams.get("selection");
  const timeseriesText = url.searchParams.get("timeseries_id");
  if (selectionText !== null && selectionText !== "random") {
    return { ok: false, message: "selection must be random" };
  }
  if (selectionText === "random" && timeseriesText !== null) {
    return {
      ok: false,
      message: "selection and timeseries_id cannot be used together",
    };
  }
  if (selectionText === null && timeseriesText === null) {
    return {
      ok: false,
      message: "selection=random or timeseries_id is required",
    };
  }

  let timeseriesId: number | null = null;
  if (timeseriesText !== null) {
    if (!/^[1-9]\d*$/.test(timeseriesText)) {
      return { ok: false, message: "timeseries_id must be a positive integer" };
    }
    timeseriesId = Number(timeseriesText);
    if (!Number.isSafeInteger(timeseriesId) || timeseriesId > 2_147_483_647) {
      return {
        ok: false,
        message: "timeseries_id is outside the supported integer range",
      };
    }
  }

  return {
    ok: true,
    value: {
      selection: selectionText === "random" ? "random" : null,
      timeseriesId,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRpcPayload(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.length === 1 && isObject(value[0])) {
    return value[0];
  }
  return isObject(value) ? value : null;
}

function validatePayload(
  payload: Record<string, unknown>,
  query: ValidatedQuery,
): string | null {
  const meta = payload.meta;
  const station = payload.station;
  const timeseries = payload.timeseries;
  const data = payload.data;
  if (
    !isObject(meta) || !isObject(station) || !isObject(timeseries) ||
    !Array.isArray(data)
  ) {
    return "response is missing meta, station, timeseries or data";
  }
  if (meta.pollutant !== "pm25" || meta.network_code !== "gov_uk_aurn") {
    return "response scope does not match the requested WHO daily-series contract";
  }
  if (
    !isValidUtcDay(meta.as_of_day_utc) ||
    !isValidUtcDay(meta.window_start_day_utc) ||
    !isValidUtcDay(meta.window_end_day_utc) ||
    meta.window_days !== 365 ||
    meta.window_end_day_utc !== meta.as_of_day_utc ||
    addUtcDays(meta.window_start_day_utc, 364) !== meta.window_end_day_utc
  ) {
    return "response has an invalid 365-day UTC window";
  }
  if (
    station.network_code !== "gov_uk_aurn" ||
    typeof station.display_name !== "string" || !station.display_name.trim()
  ) {
    return "response has invalid station metadata";
  }
  const timeseriesId = Number(timeseries.timeseries_id);
  if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
    return "response has an invalid timeseries_id";
  }
  const expectedSelection = query.selection === "random"
    ? "random"
    : "timeseries_id";
  if (
    meta.selection !== expectedSelection ||
    (query.timeseriesId !== null && timeseriesId !== query.timeseriesId)
  ) {
    return "response does not match the requested selection";
  }
  const guideline = Number(meta.who_daily_guideline_ugm3);
  if (!Number.isFinite(guideline) || guideline <= 0) {
    return "response is missing its authoritative WHO daily guideline value";
  }
  if (data.length !== 365) return "response data must contain exactly 365 days";

  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    if (!isObject(item)) return "response contains a non-object daily item";
    const expectedDay = addUtcDays(meta.window_start_day_utc, index);
    if (item.day_utc !== expectedDay) {
      return "response daily items are not complete and ordered";
    }
    if (typeof item.is_missing !== "boolean") {
      return "response daily item has an invalid missing marker";
    }
    if (item.is_missing) {
      if (item.daily_mean_ugm3 !== null || item.classification !== null) {
        return "missing date-spine placeholder contains scientific values";
      }
    } else {
      if (
        typeof item.classification !== "string" ||
        !CLASSIFICATIONS.has(item.classification)
      ) {
        return "canonical daily item has an invalid classification";
      }
      if (item.classification === "not_enough_data") {
        if (item.daily_mean_ugm3 !== null) {
          return "not_enough_data item contains a daily mean";
        }
      } else if (
        typeof item.daily_mean_ugm3 !== "number" ||
        !Number.isFinite(item.daily_mean_ugm3) || item.daily_mean_ugm3 < 0
      ) {
        return "classified daily item has an invalid daily mean";
      }
    }
    if (
      item.source_validation_status !== null &&
      item.source_validation_status !== "R" &&
      item.source_validation_status !== "P"
    ) {
      return "daily item has an invalid source_validation_status";
    }
  }
  return null;
}


async function readDailyAurnProvenance(
  env: WhoDailySeriesProxyEnv,
  timeseriesId: number,
  startDayUtc: string,
  endDayUtc: string,
): Promise<Map<string, "P" | "R">> {
  const configuredUrl = (await readSecret(
    env.UK_AQ_OBSERVS_HISTORY_R2_API_URL,
  )).trim();
  const upstreamSecret = (await readSecret(
    env.UK_AQ_EDGE_UPSTREAM_SECRET,
  )).trim();
  if (!configuredUrl || !upstreamSecret) {
    throw new Error("observation history provenance upstream is not configured");
  }
  const url = new URL(configuredUrl);
  url.pathname = OBSERVATION_PROVENANCE_PATH;
  url.search = "";
  url.searchParams.set("timeseries_id", String(timeseriesId));
  url.searchParams.set("connector_id", "1");
  url.searchParams.set("pollutant", "pm25");
  url.searchParams.set("start_utc", `${startDayUtc}T00:00:00.000Z`);
  url.searchParams.set("end_utc", `${addUtcDays(endDayUtc, 1)}T00:00:00.000Z`);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: upstreamSecret },
  });
  if (!response.ok) {
    throw new Error(`observation history provenance returned ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isObject(payload) || payload.response_complete !== true ||
    payload.has_gap === true || !Array.isArray(payload.rows)) {
    throw new Error("observation history provenance response is incomplete");
  }

  const daily = new Map<string, "P" | "R">();
  for (const raw of payload.rows) {
    if (!isObject(raw) || !isValidUtcDay(raw.day_utc) ||
      (raw.vstatus !== "P" && raw.vstatus !== "R")) {
      throw new Error("observation history provenance row is invalid");
    }
    daily.set(raw.day_utc, raw.vstatus);
  }
  return daily;
}

export async function handleWhoDailySeriesProxyRequest(
  request: Request,
  env: WhoDailySeriesProxyEnv,
  _ctx: unknown,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const requestOrigin = resolveRequestOrigin(request, requestUrl);
  const allowedOrigins = parseAllowedOrigins(
    await readSecret(env.UK_AQ_CACHE_ALLOWED_ORIGINS),
  );
  const errorResponse = (status: number, code: string, message: string) =>
    jsonError(
      status,
      code,
      message,
      request.method,
      requestOrigin,
      allowedOrigins,
    );

  if (allowedOrigins.size === 0) {
    return errorResponse(
      500,
      "missing_allowed_origins",
      "Allowed website origins are not configured",
    );
  }
  if (request.method === "OPTIONS") {
    if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
      return errorResponse(
        403,
        "origin_not_allowed",
        "Request origin is not allowed",
      );
    }
    const headers = new Headers({
      Allow: "GET, HEAD, OPTIONS",
      "Cache-Control": BROWSER_CACHE_CONTROL,
    });
    addCorsHeaders(headers, requestOrigin, allowedOrigins);
    return new Response(null, {
      status: 204,
      headers,
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = errorResponse(
      405,
      "method_not_allowed",
      "Method not allowed",
    );
    response.headers.set("Allow", "GET, HEAD, OPTIONS");
    return response;
  }
  if (requestOrigin === null) {
    return errorResponse(400, "origin_required", "Request origin is required");
  }
  if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
    return errorResponse(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }

  const validatedQuery = validateQuery(requestUrl);
  if (!validatedQuery.ok) {
    return errorResponse(
      400,
      "invalid_who_daily_series_request",
      validatedQuery.message,
    );
  }

  const supabaseUrl = (await readSecret(env.OBS_AQIDB_SUPABASE_URL)).trim()
    .replace(/\/$/, "");
  const secretKey = (await readSecret(env.OBS_AQIDB_SECRET_KEY)).trim();
  if (!supabaseUrl || !secretKey) {
    return errorResponse(
      500,
      "missing_who_daily_series_upstream",
      "WHO daily-series upstream is not configured",
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/${RPC_NAME}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Accept-Profile": RPC_SCHEMA,
        "Content-Profile": RPC_SCHEMA,
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
      },
      body: JSON.stringify({
        p_pollutant: "pm25",
        p_network_code: "gov_uk_aurn",
        p_selection: validatedQuery.value.selection,
        p_timeseries_id: validatedQuery.value.timeseriesId,
      }),
    });
  } catch (error) {
    console.error("WHO daily-series upstream request failed", error);
    return errorResponse(
      502,
      "who_daily_series_upstream_failed",
      "WHO daily series could not be read",
    );
  }

  if (!upstreamResponse.ok) {
    const detail = (await upstreamResponse.text().catch(() => "")).slice(
      0,
      300,
    );
    console.error("WHO daily-series RPC failed", {
      status: upstreamResponse.status,
      detail,
    });
    return errorResponse(
      502,
      "who_daily_series_upstream_failed",
      "WHO daily series could not be read",
    );
  }

  let decoded: unknown;
  try {
    decoded = await upstreamResponse.json();
  } catch (error) {
    console.error("WHO daily-series RPC returned invalid JSON", error);
    return errorResponse(
      502,
      "invalid_who_daily_series_upstream",
      "WHO daily series response was invalid",
    );
  }

  const noResult = decoded === null ||
    (Array.isArray(decoded) && decoded.length === 1 && decoded[0] === null);
  if (noResult) {
    return errorResponse(
      404,
      validatedQuery.value.timeseriesId === null
        ? "no_eligible_who_timeseries"
        : "who_timeseries_not_found",
      validatedQuery.value.timeseriesId === null
        ? "No eligible WHO PM2.5 timeseries is available"
        : "The requested WHO PM2.5 timeseries is not available",
    );
  }

  const payload = parseRpcPayload(decoded);
  if (payload === null) {
    console.error("WHO daily-series RPC returned an unexpected response shape");
    return errorResponse(
      502,
      "invalid_who_daily_series_upstream",
      "WHO daily series response was invalid",
    );
  }

  const payloadError = validatePayload(payload, validatedQuery.value);
  if (payloadError) {
    console.error("WHO daily-series RPC contract validation failed", {
      payloadError,
    });
    return errorResponse(
      502,
      "invalid_who_daily_series_upstream",
      "WHO daily series response was invalid",
    );
  }

  let dailyProvenance: Map<string, "P" | "R"> | null = null;
  try {
    dailyProvenance = await readDailyAurnProvenance(
      env,
      Number((payload.timeseries as Record<string, unknown>).timeseries_id),
      String((payload.meta as Record<string, unknown>).window_start_day_utc),
      String((payload.meta as Record<string, unknown>).window_end_day_utc),
    );
  } catch (error) {
    console.error("WHO daily-series provenance enrichment degraded", {
      timeseriesId: Number(
        (payload.timeseries as Record<string, unknown>).timeseries_id,
      ),
      windowStartDayUtc: String(
        (payload.meta as Record<string, unknown>).window_start_day_utc,
      ),
      windowEndDayUtc: String(
        (payload.meta as Record<string, unknown>).window_end_day_utc,
      ),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const enrichedPayload = {
    ...payload,
    data: (payload.data as Array<Record<string, unknown>>).map((item) => ({
      ...item,
      source_validation_status:
        dailyProvenance?.get(String(item.day_utc)) ??
          (item.daily_mean_ugm3 !== null ? "P" : null),
    })),
  };
  return jsonResponse(
    200,
    enrichedPayload,
    request.method,
    requestOrigin,
    allowedOrigins,
  );
}
