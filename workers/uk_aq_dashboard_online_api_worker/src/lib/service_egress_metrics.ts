import type { WorkerEnv } from "./upstream";

type MetricRow = {
  bucket_minute: string;
  env_name: string;
  project_ref: string;
  service_name: string;
  source_type: "supabase_postgrest";
  source_name: string;
  route_name: string;
  query_name: string;
  window_label: string;
  status: "ok" | "error";
  request_count: number;
  response_rows: number;
  response_bytes_est: number;
  upstream_bytes_est: number;
  duration_ms: number;
  error_count: number;
  notes: {
    measurement_method: "body_utf8";
    http_status: number;
    http_status_class: string;
  };
};

const SERVICE_NAME = "dashboard.dev";
const METRICS_RPC = "uk_aq_rpc_service_egress_metrics_batch_upsert";
const METRICS_SCHEMA = "uk_aq_public";
const BYPASS_HEADER = "x-ukaq-egress-bypass";
const EXCLUDED_ROUTES = new Set([
  "table/uk_aq_service_egress_metrics_minute",
  "table/uk_aq_service_egress_metrics_daily",
  `rpc/${METRICS_RPC}`,
]);
const aggregate = new Map<string, MetricRow>();

function enabled(env: WorkerEnv): boolean {
  const normalized = String(env.UK_AQ_SERVICE_EGRESS_METRICS_ENABLED || "").trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "n", "off"].includes(normalized);
}

function projectRef(urlValue: string): string {
  try {
    const match = new URL(urlValue).hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/);
    return match ? match[1] : "";
  } catch (_error) {
    return "";
  }
}

function host(urlValue: string | undefined): string {
  try {
    return new URL(String(urlValue || "")).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function identifySupabaseRequest(env: WorkerEnv, urlValue: string): {
  project_ref: string;
  source_name: string;
  route_name: string;
} | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch (_error) {
    return null;
  }

  const requestHost = url.hostname.toLowerCase();
  const ingestHost = host(env.SUPABASE_URL);
  const obsHost = host(env.OBS_AQIDB_SUPABASE_URL);
  const sourceName = requestHost && requestHost === ingestHost
    ? "ingestdb"
    : requestHost && requestHost === obsHost
      ? "obs_aqidb"
      : "";
  if (!sourceName) return null;

  const marker = "/rest/v1/";
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) return null;
  const resource = url.pathname.slice(markerIndex + marker.length).replace(/^\/+|\/+$/g, "");
  if (!resource) return null;
  const routeName = resource.startsWith("rpc/") ? resource : `table/${resource}`;
  if (EXCLUDED_ROUTES.has(routeName)) return null;

  return {
    project_ref: projectRef(urlValue),
    source_name: sourceName,
    route_name: routeName,
  };
}

function bucketMinuteIso(): string {
  const value = new Date();
  value.setUTCSeconds(0, 0);
  return value.toISOString();
}

export function recordDashboardSupabaseResponse(
  env: WorkerEnv,
  urlValue: string,
  response: Response,
  responseText: string,
  durationMs: number,
  queryName = "dashboard_read",
): void {
  if (!enabled(env)) return;
  const identity = identifySupabaseRequest(env, urlValue);
  if (!identity) return;

  try {
    const bucketMinute = bucketMinuteIso();
    const status = response.ok ? "ok" : "error";
    const statusClass = response.status >= 100 && response.status <= 599
      ? `${Math.trunc(response.status / 100)}xx`
      : "other";
    const key = [
      bucketMinute,
      identity.project_ref,
      identity.source_name,
      identity.route_name,
      queryName,
      status,
      String(response.status),
    ].join("\u001f");
    const current = aggregate.get(key) || {
      bucket_minute: bucketMinute,
      env_name: String(env.UKAQ_ENV_NAME || "TEST").trim() || "TEST",
      project_ref: identity.project_ref,
      service_name: SERVICE_NAME,
      source_type: "supabase_postgrest",
      source_name: identity.source_name,
      route_name: identity.route_name,
      query_name: queryName,
      window_label: "",
      status,
      request_count: 0,
      response_rows: 0,
      response_bytes_est: 0,
      upstream_bytes_est: 0,
      duration_ms: 0,
      error_count: 0,
      notes: {
        measurement_method: "body_utf8",
        http_status: response.status,
        http_status_class: statusClass,
      },
    };
    current.request_count += 1;
    current.response_bytes_est += new TextEncoder().encode(responseText).byteLength;
    current.duration_ms += Math.max(0, Math.trunc(durationMs));
    current.error_count += response.ok ? 0 : 1;
    aggregate.set(key, current);
  } catch (_error) {
    // Metrics aggregation must never affect dashboard behaviour.
  }
}

export async function flushDashboardServiceEgressMetrics(env: WorkerEnv): Promise<void> {
  if (!enabled(env) || aggregate.size === 0) return;
  const rows = Array.from(aggregate.values());
  aggregate.clear();

  const metricsUrl = String(env.OBS_AQIDB_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!metricsUrl || !serviceKey) {
    console.warn(JSON.stringify({
      event: "dashboard_service_egress_metrics_warning",
      reason: "metrics_destination_not_configured",
      rows: rows.length,
    }));
    return;
  }

  try {
    const response = await fetch(`${metricsUrl}/rest/v1/rpc/${METRICS_RPC}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": METRICS_SCHEMA,
        "Content-Profile": METRICS_SCHEMA,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        [BYPASS_HEADER]: "1",
      },
      body: JSON.stringify({ p_rows: rows }),
    });
    if (!response.ok) {
      console.warn(JSON.stringify({
        event: "dashboard_service_egress_metrics_warning",
        reason: `metrics_http_${response.status}`,
        rows: rows.length,
      }));
    }
  } catch (_error) {
    console.warn(JSON.stringify({
      event: "dashboard_service_egress_metrics_warning",
      reason: "metrics_request_failed",
      rows: rows.length,
    }));
  }
}
