const DAY_MS = 86_400_000;
const MAX_REQUEST_MS = 7 * DAY_MS;
const MAX_CHILD_INVOCATIONS = 8;
const MAX_MERGED_ROWS = 20_000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DIAGNOSTIC_MODE = "fanout_v1";
const LEAF_DIAGNOSTIC_MODE = "workload_v1";
const INDEX_GENERATION = "v3-physical-leaf-fanout-candidate";
const LEAF_INDEX_GENERATION = "v3-physical-leaf-candidate";
const CANDIDATE_VERSION = "physical-leaf-fanout-v1";
const LEAF_CANDIDATE_VERSION = "physical-leaf-index-v1";
const PHYSICAL_LAYOUT_VERSION = "timeseries-aligned-v2";
const WRITER_VERSION = "pyarrow-zstd-timeseries-aligned-candidate-v1";
const ALIGNED_ROW_CAP = 1024;
const VALID_PATHS = new Set(["/", "/v1/observations"]);

class LeafFanoutError extends Error {
  constructor(message, status = 500, options) {
    super(message, options);
    this.name = "LeafFanoutError";
    this.status = status;
  }
}

function required(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isoOrNull(value) {
  const text = required(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizePollutant(value) {
  const compact = required(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "pm25" || compact === "particulatematter25") return "pm25";
  if (compact === "pm10" || compact === "particulatematter10") return "pm10";
  if (compact === "no2" || compact === "nitrogendioxide") return "no2";
  return null;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-uk-aq-upstream-auth",
  };
}

function jsonResponse(payload, { status = 200, requestId = null } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...(requestId ? { "x-ukaq-diagnostic-request-id": requestId } : {}),
    },
  });
}

function parseRequest(url) {
  if (!VALID_PATHS.has(url.pathname)) {
    return { ok: false, status: 404, error: "Not found." };
  }
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  const connectorId = positiveInteger(url.searchParams.get("connector_id"));
  const pollutantCode = normalizePollutant(url.searchParams.get("pollutant"));
  const startIso = isoOrNull(url.searchParams.get("start_utc"));
  const endIso = isoOrNull(url.searchParams.get("end_utc"));
  if (!timeseriesId) return { ok: false, status: 400, error: "timeseries_id must be a positive integer." };
  if (!connectorId) return { ok: false, status: 400, error: "connector_id must be a positive integer." };
  if (!pollutantCode) return { ok: false, status: 400, error: "pollutant must be one of pm25, pm10, or no2." };
  if (!startIso || !endIso) return { ok: false, status: 400, error: "start_utc and end_utc must be valid ISO timestamps." };
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (endMs <= startMs) return { ok: false, status: 400, error: "end_utc must be greater than start_utc." };
  if (endMs - startMs > MAX_REQUEST_MS) {
    return { ok: false, status: 400, error: "requested range must not exceed seven days." };
  }
  if (required(url.searchParams.get("diagnostics")) !== DIAGNOSTIC_MODE) {
    return { ok: false, status: 400, error: `diagnostics=${DIAGNOSTIC_MODE} is required.` };
  }
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso };
}

export function partitionUtcDaySlices(startUtc, endUtc) {
  const startIso = isoOrNull(startUtc);
  const endIso = isoOrNull(endUtc);
  if (!startIso || !endIso) throw new Error("UTC partition bounds must be valid ISO timestamps");
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (endMs <= startMs) throw new Error("UTC partition end must be after start");
  if (endMs - startMs > MAX_REQUEST_MS) throw new Error("UTC partition range exceeds seven days");

  const slices = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const nextUtcDay = (Math.floor(cursor / DAY_MS) + 1) * DAY_MS;
    const sliceEnd = Math.min(endMs, nextUtcDay);
    slices.push(Object.freeze({
      ordinal: slices.length + 1,
      day_utc: new Date(cursor).toISOString().slice(0, 10),
      start_utc: new Date(cursor).toISOString(),
      end_utc: new Date(sliceEnd).toISOString(),
    }));
    cursor = sliceEnd;
  }
  if (!slices.length || slices.length > MAX_CHILD_INVOCATIONS) {
    throw new Error("UTC partition produced an invalid child invocation count");
  }
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    if (
      (index === 0 && slice.start_utc !== startIso) ||
      (index > 0 && slice.start_utc !== slices[index - 1].end_utc) ||
      (index === slices.length - 1 && slice.end_utc !== endIso) ||
      Date.parse(slice.end_utc) <= Date.parse(slice.start_utc)
    ) throw new Error("UTC partition is not exact, contiguous, and non-overlapping");
  }
  return Object.freeze(slices);
}

async function rowsSha256(rows) {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function exactStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new LeafFanoutError(`${label} is contradictory`, 502);
  }
  return [...new Set(value)];
}

function assertChildIdentity(payload, params, slice) {
  if (
    payload?.ok !== true ||
    payload?.read_version !== "v2" ||
    payload?.index_version !== LEAF_INDEX_GENERATION ||
    payload?.physical_leaf_candidate_version !== LEAF_CANDIDATE_VERSION ||
    payload?.physical_layout_version !== PHYSICAL_LAYOUT_VERSION ||
    payload?.writer_version !== WRITER_VERSION ||
    payload?.aligned_row_cap !== ALIGNED_ROW_CAP ||
    payload?.timeseries_id !== params.timeseriesId ||
    payload?.connector_id !== params.connectorId ||
    normalizePollutant(payload?.pollutant) !== params.pollutantCode ||
    payload?.start_utc !== slice.start_utc ||
    payload?.end_utc !== slice.end_utc ||
    payload?.since_utc !== null
  ) throw new LeafFanoutError(`child ${slice.ordinal} identity is contradictory`, 502);
}

function validateChildCompleteness(payload, slice) {
  if (typeof payload?.response_complete !== "boolean" || typeof payload?.has_gap !== "boolean") {
    throw new LeafFanoutError(`child ${slice.ordinal} completeness is contradictory`, 502);
  }
  const reasons = exactStringArray(payload.partial_reasons, `child ${slice.ordinal} partial_reasons`);
  const state = required(payload.coverage_state);
  const coverage = payload.coverage;
  if (
    (payload.response_complete && (payload.has_gap || state !== "complete" || reasons.length)) ||
    (!payload.response_complete && (!payload.has_gap || state !== "partial" || !reasons.length)) ||
    coverage?.response_complete !== payload.response_complete ||
    coverage?.has_gap !== payload.has_gap ||
    coverage?.coverage_state !== state ||
    JSON.stringify(coverage?.partial_reasons) !== JSON.stringify(payload.partial_reasons) ||
    coverage?.limited_by_limit !== false ||
    coverage?.total_rows_before_limit !== payload.row_count
  ) throw new LeafFanoutError(`child ${slice.ordinal} completeness evidence is contradictory`, 502);
  return { response_complete: payload.response_complete, partial_reasons: reasons };
}

function validateChildRows(payload, slice) {
  if (!Array.isArray(payload?.rows) || payload.row_count !== payload.rows.length) {
    throw new LeafFanoutError(`child ${slice.ordinal} row count is contradictory`, 502);
  }
  const startMs = Date.parse(slice.start_utc);
  const endMs = Date.parse(slice.end_utc);
  let previousObservedAt = null;
  let previousValue = null;
  return payload.rows.map((raw) => {
    const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      keys.length !== 2 ||
      !Object.hasOwn(raw, "observed_at") ||
      !Object.hasOwn(raw, "value")
    ) throw new LeafFanoutError(`child ${slice.ordinal} row shape is contradictory`, 502);
    const observedAt = required(raw.observed_at);
    const value = raw.value;
    const timestamp = Date.parse(observedAt);
    if (
      !observedAt ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== observedAt ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      timestamp < startMs ||
      timestamp >= endMs ||
      (previousObservedAt !== null && observedAt < previousObservedAt) ||
      (previousObservedAt === observedAt && previousValue !== value)
    ) throw new LeafFanoutError(`child ${slice.ordinal} row identity or order is contradictory`, 502);
    previousObservedAt = observedAt;
    previousValue = value;
    return { observed_at: observedAt, value };
  });
}

async function readChild({ binding, secret, params, slice }) {
  const url = new URL("https://physical-leaf-candidate.internal/v1/observations");
  for (const [key, value] of Object.entries({
    connector_id: params.connectorId,
    pollutant: params.pollutantCode,
    timeseries_id: params.timeseriesId,
    start_utc: slice.start_utc,
    end_utc: slice.end_utc,
    diagnostics: LEAF_DIAGNOSTIC_MODE,
  })) url.searchParams.set(key, String(value));
  const response = await binding.fetch(new Request(url, {
    method: "GET",
    headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret },
  }));
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* handled as a closed child failure below */ }
  if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new LeafFanoutError(`child ${slice.ordinal} request failed with status ${response.status}`, 502);
  }
  assertChildIdentity(payload, params, slice);
  const completeness = validateChildCompleteness(payload, slice);
  const rows = validateChildRows(payload, slice);
  const headerRequestId = required(response.headers.get("x-ukaq-diagnostic-request-id"));
  const bodyRequestId = required(payload.diagnostic_request?.request_id);
  if (
    !headerRequestId ||
    !bodyRequestId ||
    headerRequestId !== bodyRequestId ||
    payload.diagnostic_request?.mode !== LEAF_DIAGNOSTIC_MODE ||
    payload.diagnostic_request?.rows_returned !== rows.length
  ) throw new LeafFanoutError(`child ${slice.ordinal} diagnostic identity is contradictory`, 502);
  const headerRay = required(response.headers.get("cf-ray")) || null;
  const bodyRay = required(payload.diagnostic_request?.cloudflare_ray_id) || null;
  return Object.freeze({
    ...slice,
    rows,
    rows_returned: rows.length,
    response_complete: completeness.response_complete,
    partial_reasons: completeness.partial_reasons,
    diagnostic_request_id: bodyRequestId,
    cloudflare_ray_id: bodyRay || headerRay,
    response_cf_ray: headerRay,
  });
}

export async function executeLeafFanout({ binding, secret, params }) {
  if (!binding || typeof binding.fetch !== "function") {
    throw new LeafFanoutError("Missing PHYSICAL_LEAF Service Binding");
  }
  const slices = partitionUtcDaySlices(params.startIso, params.endIso);
  const children = await Promise.all(slices.map((slice) => readChild({
    binding,
    secret,
    params,
    slice,
  })));

  const rows = [];
  let previousObservedAt = null;
  let previousValue = null;
  for (const child of children) {
    for (const row of child.rows) {
      if (
        (previousObservedAt !== null && row.observed_at < previousObservedAt) ||
        (previousObservedAt === row.observed_at && previousValue !== row.value)
      ) throw new LeafFanoutError("merged child rows overlap or conflict", 502);
      previousObservedAt = row.observed_at;
      previousValue = row.value;
      rows.push(row);
      if (rows.length > MAX_MERGED_ROWS) {
        throw new LeafFanoutError("merged child row budget exceeded", 502);
      }
    }
  }
  const partialReasons = [...new Set(children.flatMap((child) => child.partial_reasons))];
  const responseComplete = children.every((child) => child.response_complete) && partialReasons.length === 0;
  return Object.freeze({
    slices,
    children,
    rows,
    rows_sha256: await rowsSha256(rows),
    response_complete: responseComplete,
    partial_reasons: partialReasons,
  });
}

function assertConfiguration(env) {
  if (required(env.UKAQ_ENV_NAME).toUpperCase() !== "TEST") {
    throw new LeafFanoutError("Leaf fan-out candidate requires UKAQ_ENV_NAME=TEST");
  }
  if (required(env.UK_AQ_R2_HISTORY_INDEX_VERSION) !== INDEX_GENERATION) {
    throw new LeafFanoutError(`Leaf fan-out candidate requires UK_AQ_R2_HISTORY_INDEX_VERSION=${INDEX_GENERATION}`);
  }
  if (!env.PHYSICAL_LEAF || typeof env.PHYSICAL_LEAF.fetch !== "function") {
    throw new LeafFanoutError("Missing PHYSICAL_LEAF Service Binding");
  }
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!secret) throw new LeafFanoutError("Missing UK_AQ_EDGE_UPSTREAM_SECRET");
  return secret;
}

function authorize(request, secret) {
  const supplied = required(request.headers.get(UPSTREAM_AUTH_HEADER));
  return Boolean(supplied && timingSafeEqual(supplied, secret));
}

function coordinatorDiagnostic({ requestId, cloudflareRayId, result }) {
  return {
    schema_version: 1,
    mode: DIAGNOSTIC_MODE,
    role: "coordinator",
    request_id: requestId,
    cloudflare_ray_id: cloudflareRayId,
    cpu_time_ms: null,
    cpu_time_source: "cloudflare_invocation_logs_or_analytics",
    requested_utc_days: result.slices.map((slice) => slice.day_utc),
    child_invocation_count: result.children.length,
    child_requests: result.children.map((child) => ({
      ordinal: child.ordinal,
      day_utc: child.day_utc,
      start_utc: child.start_utc,
      end_utc: child.end_utc,
      rows_returned: child.rows_returned,
      response_complete: child.response_complete,
      partial_reasons: child.partial_reasons,
      diagnostic_request_id: child.diagnostic_request_id,
      cloudflare_ray_id: child.cloudflare_ray_id,
      response_cf_ray: child.response_cf_ray,
    })),
    merged_rows: result.rows.length,
    response_complete: result.response_complete,
    partial_reasons: result.partial_reasons,
    final_rows_sha256: result.rows_sha256,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed." }, { status: 405 });
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const cloudflareRayId = required(request.headers.get("cf-ray")) || null;
    try {
      const secret = assertConfiguration(env);
      if (!authorize(request, secret)) return jsonResponse({ ok: false, error: "Unauthorized." }, { status: 401 });
      const params = parseRequest(url);
      if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status });
      console.info(JSON.stringify({
        event: "observation_history_v3_leaf_fanout_candidate_diagnostic_start",
        diagnostic_request_id: requestId,
        cloudflare_ray_id: cloudflareRayId,
        connector_id: params.connectorId,
        pollutant_code: params.pollutantCode,
        timeseries_id: params.timeseriesId,
        start_utc: params.startIso,
        end_utc: params.endIso,
      }));
      const result = await executeLeafFanout({ binding: env.PHYSICAL_LEAF, secret, params });
      const diagnosticRequest = coordinatorDiagnostic({ requestId, cloudflareRayId, result });
      console.info(JSON.stringify({
        event: "observation_history_v3_leaf_fanout_candidate_diagnostic_complete",
        diagnostic_request: diagnosticRequest,
      }));
      return jsonResponse({
        ok: true,
        generated_at_utc: new Date().toISOString(),
        read_version: "v2",
        index_version: INDEX_GENERATION,
        physical_leaf_fanout_candidate_version: CANDIDATE_VERSION,
        leaf_index_version: LEAF_INDEX_GENERATION,
        leaf_candidate_version: LEAF_CANDIDATE_VERSION,
        pollutant: params.pollutantCode,
        physical_layout_version: PHYSICAL_LAYOUT_VERSION,
        writer_version: WRITER_VERSION,
        aligned_row_cap: ALIGNED_ROW_CAP,
        timeseries_id: params.timeseriesId,
        connector_id: params.connectorId,
        start_utc: params.startIso,
        end_utc: params.endIso,
        row_count: result.rows.length,
        rows_sha256: result.rows_sha256,
        response_complete: result.response_complete,
        has_gap: !result.response_complete,
        coverage_state: result.response_complete ? "complete" : "partial",
        partial_reasons: result.partial_reasons,
        rows: result.rows,
        diagnostic_request: diagnosticRequest,
        coverage: {
          response_complete: result.response_complete,
          has_gap: !result.response_complete,
          coverage_state: result.response_complete ? "complete" : "partial",
          partial_reasons: result.partial_reasons,
          requested_utc_days: diagnosticRequest.requested_utc_days,
          child_invocation_count: result.children.length,
          merged_rows: result.rows.length,
          rows_sha256: result.rows_sha256,
        },
      }, { requestId });
    } catch (error) {
      const status = error instanceof LeafFanoutError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      const diagnosticRequest = {
        schema_version: 1,
        mode: DIAGNOSTIC_MODE,
        role: "coordinator",
        request_id: requestId,
        cloudflare_ray_id: cloudflareRayId,
        outcome: "error",
        cpu_time_ms: null,
        cpu_time_source: "cloudflare_invocation_logs_or_analytics",
      };
      console.warn(JSON.stringify({
        event: "observation_history_v3_leaf_fanout_candidate_error",
        path: url.pathname,
        error: message,
        diagnostic_request: diagnosticRequest,
      }));
      return jsonResponse({ ok: false, error: message, diagnostic_request: diagnosticRequest }, { status, requestId });
    }
  },
};
