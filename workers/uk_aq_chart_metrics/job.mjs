import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

import { withDailyTaskRun } from "../shared/daily_task_health.mjs";

const RPC_SCHEMA = "uk_aq_public";
const REPORT_PATH = "tmp/uk_aq_chart_metrics_report.json";

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function resolveChartMetricsConfig(env = process.env) {
  const supabaseUrl = String(env.OBS_AQIDB_SUPABASE_URL || "").trim();
  const secretKey = String(env.OBS_AQIDB_SECRET_KEY || "").trim();
  if (!supabaseUrl || !secretKey) throw new Error("Chart metrics requires OBS_AQIDB_SUPABASE_URL and OBS_AQIDB_SECRET_KEY");
  return {
    supabaseUrl,
    secretKey,
    retentionDays: positiveInt(env.UK_AQ_CHART_METRICS_RETENTION_DAYS, 90, 3650),
    refreshDays: positiveInt(env.UK_AQ_CHART_METRICS_DAILY_REFRESH_DAYS, 7, 31),
    cleanupRpc: String(env.UK_AQ_CHART_METRICS_CLEANUP_RPC || "uk_aq_rpc_chart_load_metrics_cleanup").trim(),
    refreshRpc: String(env.UK_AQ_CHART_METRICS_DAILY_REFRESH_RPC || "uk_aq_rpc_chart_load_metrics_daily_refresh").trim(),
  };
}

export async function runChartMetricsMaintenance(config, { createClientAdapter = createClient } = {}) {
  const client = createClientAdapter(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: RPC_SCHEMA },
  });
  const cleanup = await client.schema(RPC_SCHEMA).rpc(config.cleanupRpc, { p_retention_days: config.retentionDays });
  if (cleanup.error) throw new Error(`chart metrics cleanup RPC failed: ${cleanup.error.message}`);
  const refresh = await client.schema(RPC_SCHEMA).rpc(config.refreshRpc, { p_recent_days: config.refreshDays });
  if (refresh.error) throw new Error(`chart metrics daily refresh RPC failed: ${refresh.error.message}`);
  const refreshRow = refresh.data?.[0] || {};
  return {
    retention_days: config.retentionDays,
    refresh_days: config.refreshDays,
    cleanup_rpc: config.cleanupRpc,
    daily_refresh_rpc: config.refreshRpc,
    raw_rows_deleted: Number(cleanup.data?.[0]?.rows_deleted ?? 0),
    daily_rows_upserted: Number(refreshRow.rows_upserted ?? 0),
    daily_days_refreshed: Number(refreshRow.days_refreshed ?? config.refreshDays),
    daily_refreshed_from_day_utc: refreshRow.refreshed_from_day_utc ?? null,
    daily_refreshed_to_day_utc: refreshRow.refreshed_to_day_utc ?? null,
  };
}

export async function executeChartMetrics(env = process.env, adapters = {}) {
  const config = resolveChartMetricsConfig(env);
  const withDailyTaskRunAdapter = adapters.withDailyTaskRun || withDailyTaskRun;
  return await withDailyTaskRunAdapter({
    task_key: "ops.chart_metrics",
    source_repo: "uk-aq-ops",
    source_worker: "uk_aq_chart_metrics",
    startSummary: { retention_days: config.retentionDays, refresh_days: config.refreshDays },
  }, async () => await runChartMetricsMaintenance(config, adapters));
}

async function main() {
  let payload;
  try {
    payload = { ok: true, summary: await executeChartMetrics() };
  } catch (error) {
    payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  }
  await mkdir("tmp", { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
