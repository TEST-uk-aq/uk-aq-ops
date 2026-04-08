import { errorEnvelope, okEnvelope } from "../lib/http";
import { fetchUpstreamJson, UpstreamError, type WorkerEnv } from "../lib/upstream";

type DashboardPayload = {
  project_ref?: string;
  generated_at?: string;
  buckets?: unknown;
  pollutants?: unknown;
  dispatch_runs?: unknown;
  dispatch_cursor?: string;
  connectors_settings?: unknown;
  dispatcher_settings?: unknown;
  db_size_metrics?: unknown;
  schema_size_metrics?: unknown;
  r2_domain_size_metrics?: unknown;
  db_size_metrics_error?: unknown;
  schema_size_metrics_error?: unknown;
  r2_domain_size_metrics_error?: unknown;
  r2_usage?: unknown;
  r2_usage_error?: unknown;
  r2_backup_window?: unknown;
  r2_backup_window_error?: unknown;
  r2_history_days_bucket?: unknown;
  r2_history_days_error?: unknown;
  dropbox_backup_state_path?: unknown;
  dropbox_backup_state_error?: unknown;
  storage_coverage_source?: unknown;
  storage_coverage_days?: unknown;
};

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function fetchDashboardPayload(
  env: WorkerEnv,
  includeStorageCoverage: boolean,
  incomingSearch: URLSearchParams,
): Promise<DashboardPayload> {
  const params = new URLSearchParams(incomingSearch);
  params.set("include_storage_coverage", includeStorageCoverage ? "1" : "0");
  const payload = await fetchUpstreamJson(env, "/api/dashboard", params);
  return payload as DashboardPayload;
}

function extractErrorMessage(err: unknown): { code: string; message: string; status: number } {
  if (err instanceof UpstreamError) {
    return { code: err.code, message: err.message, status: err.status };
  }
  if (err instanceof Error) {
    return { code: "UNEXPECTED_ERROR", message: err.message, status: 500 };
  }
  return { code: "UNEXPECTED_ERROR", message: String(err), status: 500 };
}

export async function handleHealthRoute(env: WorkerEnv): Promise<Response> {
  const upstreamConfigured = Boolean(String(env.DASHBOARD_UPSTREAM_BASE_URL || "").trim());
  return okEnvelope({
    service: "uk-aq-ops-dashboard-api",
    upstreamConfigured,
  });
}

export async function handleStatusSummaryRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, false, search);
    return okEnvelope({
      project_ref: payload.project_ref || null,
      generated_at: payload.generated_at || null,
      dispatch_cursor: payload.dispatch_cursor || null,
      connectors_count: arrayLength(payload.connectors_settings),
      dispatch_runs_count: arrayLength(payload.dispatch_runs),
      pollutant_panels_count: arrayLength(payload.pollutants),
      buckets: Array.isArray(payload.buckets) ? payload.buckets : [],
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}

export async function handleStatusFeedsRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, false, search);
    return okEnvelope({
      generated_at: payload.generated_at || null,
      dispatch_cursor: payload.dispatch_cursor || null,
      connectors_settings: Array.isArray(payload.connectors_settings) ? payload.connectors_settings : [],
      dispatcher_settings:
        payload.dispatcher_settings && typeof payload.dispatcher_settings === "object"
          ? payload.dispatcher_settings
          : null,
      dispatch_runs: Array.isArray(payload.dispatch_runs) ? payload.dispatch_runs : [],
      pollutants: Array.isArray(payload.pollutants) ? payload.pollutants : [],
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}

export async function handleStatusDbRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, false, search);
    return okEnvelope({
      generated_at: payload.generated_at || null,
      db_size_metrics: Array.isArray(payload.db_size_metrics) ? payload.db_size_metrics : [],
      schema_size_metrics: Array.isArray(payload.schema_size_metrics) ? payload.schema_size_metrics : [],
      r2_domain_size_metrics: Array.isArray(payload.r2_domain_size_metrics)
        ? payload.r2_domain_size_metrics
        : [],
      db_size_metrics_error: payload.db_size_metrics_error || null,
      schema_size_metrics_error: payload.schema_size_metrics_error || null,
      r2_domain_size_metrics_error: payload.r2_domain_size_metrics_error || null,
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}

export async function handleStatusHistoryRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, true, search);
    return okEnvelope({
      generated_at: payload.generated_at || null,
      r2_usage: payload.r2_usage || null,
      r2_usage_error: payload.r2_usage_error || null,
      r2_backup_window: payload.r2_backup_window || null,
      r2_backup_window_error: payload.r2_backup_window_error || null,
      r2_history_days_bucket: payload.r2_history_days_bucket || null,
      r2_history_days_error: payload.r2_history_days_error || null,
      dropbox_backup_state_path: payload.dropbox_backup_state_path || null,
      dropbox_backup_state_error: payload.dropbox_backup_state_error || null,
      storage_coverage_source: payload.storage_coverage_source || null,
      storage_coverage_days: Array.isArray(payload.storage_coverage_days)
        ? payload.storage_coverage_days
        : [],
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}

export async function handleHistoryManifestsRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, true, search);
    return okEnvelope({
      generated_at: payload.generated_at || null,
      storage_coverage_source: payload.storage_coverage_source || null,
      storage_coverage_days: Array.isArray(payload.storage_coverage_days)
        ? payload.storage_coverage_days
        : [],
      r2_history_days_bucket: payload.r2_history_days_bucket || null,
      r2_history_days_error: payload.r2_history_days_error || null,
      r2_backup_window: payload.r2_backup_window || null,
      r2_backup_window_error: payload.r2_backup_window_error || null,
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}

export async function handleHistoryRunsRoute(
  env: WorkerEnv,
  search: URLSearchParams,
): Promise<Response> {
  try {
    const payload = await fetchDashboardPayload(env, false, search);
    return okEnvelope({
      generated_at: payload.generated_at || null,
      dispatch_cursor: payload.dispatch_cursor || null,
      dispatch_runs: Array.isArray(payload.dispatch_runs) ? payload.dispatch_runs : [],
    });
  } catch (err) {
    const mapped = extractErrorMessage(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.status);
  }
}
