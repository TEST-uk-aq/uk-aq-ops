import {
  buildDailyRefreshPayload,
  buildDayChunks,
  buildRunConfig,
  DailyRefreshRpcRow,
  mergeDailyRefreshRows,
  parsePollutantCodes,
  parsePositiveInt,
  parseRunMode,
  parseTriggerMode,
} from "./who_2021_daily_core.ts";

type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

const OBS_AQIDB_SUPABASE_URL = requiredEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQIDB_PRIVILEGED_KEY = requiredEnv("OBS_AQIDB_SECRET_KEY");
const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public")
  .trim();
const DAILY_REFRESH_RPC = (Deno.env.get("UK_AQ_WHO_2021_DAILY_REFRESH_RPC") ||
  "uk_aq_rpc_who_2021_daily_status_refresh").trim();
const RUN_LOG_RPC = (Deno.env.get("UK_AQ_WHO_2021_RUN_LOG_RPC") ||
  "uk_aq_rpc_who_2021_processing_run_log").trim();
const RPC_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_RPC_RETRIES"),
  3,
);

const RUN_MODE = parseRunMode(Deno.env.get("UK_AQ_WHO_2021_RUN_MODE"));
const TRIGGER_MODE = parseTriggerMode(
  Deno.env.get("UK_AQ_WHO_2021_TRIGGER_MODE"),
);
const SOURCE_NETWORK_CODE =
  (Deno.env.get("UK_AQ_WHO_2021_SOURCE_NETWORK_CODE") ||
    "gov_uk_aurn").trim().toLowerCase();
const CONNECTOR_ID = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_CONNECTOR_ID"),
  1,
);
const POLLUTANT_CODES = parsePollutantCodes(
  Deno.env.get("UK_AQ_WHO_2021_POLLUTANT_CODES"),
);
const MIN_VALID_HOURS_PER_DAY = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY"),
  18,
);
const DAILY_LOOKBACK_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_DAILY_LOOKBACK_DAYS"),
  2,
);
const MATURITY_DELAY_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_MATURITY_DELAY_HOURS"),
  3,
);
const CHUNK_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_CHUNK_DAYS"),
  31,
);
const START_DAY_UTC = optionalEnv("UK_AQ_WHO_2021_START_DAY_UTC");
const END_DAY_UTC = optionalEnv("UK_AQ_WHO_2021_END_DAY_UTC");

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | null {
  const value = (Deno.env.get(name) || "").trim();
  return value || null;
}

function normalizeUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}/rest/v1`;
}

function asErrorMessage(payload: unknown, status: number): string {
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

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postgrestRpc<T>(
  rpcName: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const url = `${normalizeUrl(OBS_AQIDB_SUPABASE_URL)}/rpc/${rpcName}`;
  const headers: Record<string, string> = {
    apikey: OBS_AQIDB_PRIVILEGED_KEY,
    Authorization: `Bearer ${OBS_AQIDB_PRIVILEGED_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": RPC_SCHEMA,
    "Content-Profile": RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_who_2021_daily_cloud_run",
  };

  for (let attempt = 1; attempt <= RPC_RETRIES; attempt += 1) {
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

      if (attempt < RPC_RETRIES && isRetryableStatus(response.status)) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return {
        data: null,
        error: { message: asErrorMessage(payload, response.status) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < RPC_RETRIES) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return { data: null, error: { message } };
    }
  }

  return { data: null, error: { message: "unknown_rpc_error" } };
}

function parseDailyRefreshRows(data: unknown): DailyRefreshRpcRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((item) => item as DailyRefreshRpcRow);
}

function errorJson(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    source_file: "workers/uk_aq_who_2021_daily_cloud_run/run_job.ts",
  };
}

async function logRun(args: {
  runMode: string;
  triggerMode: string;
  sourceNetworkCode: string;
  pollutantCodes: string[];
  startDayUtc: string;
  endDayUtc: string;
  latestCompleteDayUtc: string;
  runStatus: "ok" | "error" | "dry_run";
  dailyRowsUpserted: number;
  summaryJson: Record<string, unknown> | null;
  errorJson: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string;
}): Promise<string | null> {
  const result = await postgrestRpc<unknown>(RUN_LOG_RPC, {
    p_run_mode: args.runMode,
    p_trigger_mode: args.triggerMode,
    p_source_network_code: args.sourceNetworkCode,
    p_pollutant_codes: args.pollutantCodes,
    p_window_start_day_utc: args.startDayUtc,
    p_window_end_day_utc: args.endDayUtc,
    p_latest_complete_day_utc: args.latestCompleteDayUtc,
    p_run_status: args.runStatus,
    p_daily_rows_upserted: args.dailyRowsUpserted,
    p_summary_json: args.summaryJson,
    p_error_json: args.errorJson,
    p_started_at: args.startedAt,
    p_finished_at: args.finishedAt,
  });
  if (result.error) {
    console.error(JSON.stringify({
      level: "error",
      event: "who_2021_run_log_failed",
      message: result.error.message,
    }));
    return null;
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  const first = rows[0] as Record<string, unknown> | undefined;
  return typeof first?.run_id === "string" ? first.run_id : null;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const config = buildRunConfig({
    runMode: RUN_MODE,
    triggerMode: TRIGGER_MODE,
    now: new Date(),
    explicitStartDayUtc: START_DAY_UTC,
    explicitEndDayUtc: END_DAY_UTC,
    lookbackDays: DAILY_LOOKBACK_DAYS,
    maturityDelayHours: MATURITY_DELAY_HOURS,
    connectorId: CONNECTOR_ID,
    sourceNetworkCode: SOURCE_NETWORK_CODE,
    pollutantCodes: POLLUTANT_CODES,
    minValidHoursPerDay: MIN_VALID_HOURS_PER_DAY,
    chunkDays: CHUNK_DAYS,
  });
  const chunks = buildDayChunks(
    config.startDayUtc,
    config.endDayUtc,
    config.chunkDays,
  );
  const rows: DailyRefreshRpcRow[] = [];
  let runStatus: "ok" | "error" | "dry_run" = config.dryRun ? "dry_run" : "ok";
  let capturedError: unknown = null;

  try {
    for (const chunk of chunks) {
      const payload = buildDailyRefreshPayload(config, chunk);
      console.log(JSON.stringify({
        level: "info",
        event: "who_2021_daily_refresh_chunk_start",
        run_mode: config.runMode,
        trigger_mode: config.triggerMode,
        ...payload,
      }));
      const result = await postgrestRpc<unknown>(DAILY_REFRESH_RPC, payload);
      if (result.error) {
        throw new Error(`daily refresh RPC failed: ${result.error.message}`);
      }
      rows.push(...parseDailyRefreshRows(result.data));
    }
  } catch (error) {
    runStatus = "error";
    capturedError = error;
  }

  const summary = mergeDailyRefreshRows(rows);
  const finishedAt = new Date().toISOString();
  const summaryJson = {
    run_mode: config.runMode,
    trigger_mode: config.triggerMode,
    source_network_code: config.sourceNetworkCode,
    connector_id: config.connectorId,
    pollutant_codes: config.pollutantCodes,
    start_day_utc: config.startDayUtc,
    end_day_utc: config.endDayUtc,
    latest_complete_day_utc: config.latestCompleteDayUtc,
    min_valid_hours_per_day: config.minValidHoursPerDay,
    dry_run: config.dryRun,
    ...summary,
  };
  const loggedRunId = await logRun({
    runMode: config.runMode,
    triggerMode: config.triggerMode,
    sourceNetworkCode: config.sourceNetworkCode,
    pollutantCodes: config.pollutantCodes,
    startDayUtc: config.startDayUtc,
    endDayUtc: config.endDayUtc,
    latestCompleteDayUtc: config.latestCompleteDayUtc,
    runStatus,
    dailyRowsUpserted: summary.rows_upserted,
    summaryJson,
    errorJson: capturedError ? errorJson(capturedError) : null,
    startedAt,
    finishedAt,
  });

  const output = {
    ok: runStatus !== "error",
    run_status: runStatus,
    run_id: loggedRunId,
    ...summaryJson,
    error: capturedError ? errorJson(capturedError) : null,
  };
  console.log(JSON.stringify(output));

  if (capturedError) {
    throw capturedError;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "who_2021_daily_run_failed",
      ...errorJson(error),
    }));
    Deno.exit(1);
  }
}
