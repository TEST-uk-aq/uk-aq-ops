import {
  buildDailyRefreshPayload,
  buildDayChunks,
  buildR2PublishPlan,
  buildReadinessPayload,
  buildRunConfig,
  buildSummaryRefreshPayload,
  DailyRefreshRpcRow,
  mergeDailyRefreshRows,
  parsePollutantCodes,
  parsePositiveInt,
  parseRunMode,
  parseTriggerMode,
  ReadinessRpcRow,
  shouldRunReadinessGate,
  stableJson,
  summarizeReadinessRows,
  SummaryRefreshRpcRow,
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
const READINESS_RPC = (Deno.env.get("UK_AQ_WHO_2021_READINESS_RPC") ||
  "uk_aq_rpc_who_2021_readiness_check").trim();
const SUMMARY_REFRESH_RPC =
  (Deno.env.get("UK_AQ_WHO_2021_SUMMARY_REFRESH_RPC") ||
    "uk_aq_rpc_who_2021_summary_refresh").trim();
const PARQUET_R2_WRITE_RPC =
  (Deno.env.get("UK_AQ_WHO_2021_PARQUET_R2_WRITE_RPC") ||
    "uk_aq_rpc_who_2021_r2_parquet_write").trim();
const R2_PUBLISH_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_WHO_2021_R2_PUBLISH_ENABLED"),
  false,
);
const PARQUET_R2_WRITE_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_WHO_2021_PARQUET_R2_WRITE_ENABLED"),
  R2_PUBLISH_ENABLED,
);
const R2_ENDPOINT = optionalEnv("R2_ENDPOINT") ||
  optionalEnv("CFLARE_R2_ENDPOINT");
const R2_BUCKET = optionalEnv("R2_BUCKET") ||
  optionalEnv("CFLARE_R2_BUCKET");
const R2_REGION = optionalEnv("R2_REGION") || "auto";
const R2_ACCESS_KEY_ID = optionalEnv("R2_ACCESS_KEY_ID") ||
  optionalEnv("CFLARE_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = optionalEnv("R2_SECRET_ACCESS_KEY") ||
  optionalEnv("CFLARE_R2_SECRET_ACCESS_KEY");

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
const MIN_VALID_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_WHO_2021_MIN_VALID_DAYS"),
  274,
);
const MIN_FINAL_HOUR_COVERAGE_RATIO = parseRatio(
  Deno.env.get("UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO"),
  0.9,
);
const READINESS_GATE_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_WHO_2021_READINESS_GATE_ENABLED"),
  true,
);
const SUMMARY_REFRESH_ENABLED = parseBoolean(
  Deno.env.get("UK_AQ_WHO_2021_SUMMARY_REFRESH_ENABLED"),
  true,
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

function parseBoolean(
  raw: string | null | undefined,
  fallback: boolean,
): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function parseRatio(raw: string | null | undefined, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
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

function parseReadinessRows(data: unknown): ReadinessRpcRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((item) => item as ReadinessRpcRow);
}

function parseSummaryRefreshRows(data: unknown): SummaryRefreshRpcRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((item) => item as SummaryRefreshRpcRow);
}

function errorJson(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    source_file: "workers/uk_aq_who_2021_daily_cloud_run/run_job.ts",
  };
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function hmacSha256(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function signedR2Put(
  objectKey: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<void> {
  if (
    !R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      "R2 publication is enabled but R2 endpoint/bucket/access key/secret key env vars are incomplete",
    );
  }
  const payload = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body;
  const payloadHash = await sha256Hex(payload);
  const endpoint = new URL(R2_ENDPOINT.replace(/\/$/, ""));
  const canonicalUri = `/${R2_BUCKET}/${
    objectKey.split("/").filter(Boolean).map(encodePathPart).join("/")
  }`;
  const now = new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const headers = {
    "content-type": contentType,
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) =>
    a.localeCompare(b)
  ).map(([k, v]) => `${k}:${v}`).join("\n");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${R2_REGION}/s3/aws4_request`;
  const kDate = await hmacSha256(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = await hmacSha256(kDate, R2_REGION);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hex(await hmacSha256(kSigning, stringToSign));
  const url = new URL(R2_ENDPOINT.replace(/\/$/, ""));
  url.pathname = canonicalUri;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload as BodyInit,
  });
  if (!response.ok) {
    throw new Error(
      `R2 PUT failed for ${objectKey}: HTTP ${response.status} ${await response
        .text().catch(() => "")}`,
    );
  }
}

type ParquetR2WritePart = {
  object_key: string;
  content_base64: string;
  content_type?: string;
};

async function publishPhase4(
  args: {
    config: ReturnType<typeof buildRunConfig>;
    summaryRefresh: SummaryRefreshRpcRow | null;
    homepageSummary: Record<string, unknown> | null;
  },
): Promise<Record<string, unknown>> {
  if (!args.config.r2PublishEnabled || args.config.dryRun) {
    return { enabled: args.config.r2PublishEnabled, skipped: true };
  }
  if (!args.summaryRefresh) {
    throw new Error(
      "R2 publication is enabled but summary refresh returned no row",
    );
  }
  if (!args.homepageSummary) {
    throw new Error(
      "R2 publication is enabled but summary refresh returned no homepage_summary",
    );
  }
  const plan = buildR2PublishPlan({
    asOfDayUtc: args.config.endDayUtc,
    connectorId: args.config.connectorId,
    pollutantCodes: args.config.pollutantCodes,
    calendarYear: args.summaryRefresh.calendar_year,
  });
  const parquetObjects: string[] = [];
  if (args.config.parquetR2WriteEnabled) {
    const result = await postgrestRpc<unknown>(PARQUET_R2_WRITE_RPC, {
      p_as_of_day_utc: args.config.endDayUtc,
      p_start_day_utc: args.config.startDayUtc,
      p_end_day_utc: args.config.endDayUtc,
      p_connector_id: args.config.connectorId,
      p_source_network_code: args.config.sourceNetworkCode,
      p_pollutant_codes: args.config.pollutantCodes,
    });
    if (result.error) {
      throw new Error(`parquet R2 write RPC failed: ${result.error.message}`);
    }
    const parts =
      (Array.isArray(result.data) ? result.data : []) as ParquetR2WritePart[];
    for (const part of parts) {
      if (!part.object_key || !part.content_base64) continue;
      const bytes = Uint8Array.from(
        atob(part.content_base64),
        (c) => c.charCodeAt(0),
      );
      await signedR2Put(
        part.object_key,
        bytes,
        part.content_type || "application/vnd.apache.parquet",
      );
      parquetObjects.push(part.object_key);
    }
  }
  const body = stableJson(args.homepageSummary);
  await signedR2Put(
    plan.datedSummaryKey,
    body,
    "application/json; charset=utf-8",
  );
  await signedR2Put(
    plan.latestSummaryKey,
    body,
    "application/json; charset=utf-8",
  );
  return {
    enabled: true,
    skipped: false,
    plan,
    parquet_objects_written: parquetObjects.length,
    parquet_object_keys: parquetObjects,
    summary_object_keys: [plan.datedSummaryKey, plan.latestSummaryKey],
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
  rollingRowsUpserted: number;
  calendarRowsUpserted: number;
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
    p_rolling_rows_upserted: args.rollingRowsUpserted,
    p_calendar_rows_upserted: args.calendarRowsUpserted,
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
    minValidDays: MIN_VALID_DAYS,
    minFinalHourCoverageRatio: MIN_FINAL_HOUR_COVERAGE_RATIO,
    readinessGateEnabled: READINESS_GATE_ENABLED,
    summaryRefreshEnabled: SUMMARY_REFRESH_ENABLED,
    r2PublishEnabled: R2_PUBLISH_ENABLED,
    parquetR2WriteEnabled: PARQUET_R2_WRITE_ENABLED,
    chunkDays: CHUNK_DAYS,
  });
  const chunks = buildDayChunks(
    config.startDayUtc,
    config.endDayUtc,
    config.chunkDays,
  );
  const rows: DailyRefreshRpcRow[] = [];
  const summaryRefreshRows: SummaryRefreshRpcRow[] = [];
  let readinessSummary: Record<string, unknown> | null = null;
  let deferred = false;
  let alreadyCompleted = false;
  let runStatus: "ok" | "error" | "dry_run" = config.dryRun ? "dry_run" : "ok";
  let capturedError: unknown = null;
  let r2PublishSummary: Record<string, unknown> | null = null;

  try {
    if (shouldRunReadinessGate(config)) {
      const payload = buildReadinessPayload(config);
      console.log(JSON.stringify({
        level: "info",
        event: "who_2021_readiness_check_start",
        run_mode: config.runMode,
        trigger_mode: config.triggerMode,
        ...payload,
      }));
      const result = await postgrestRpc<unknown>(READINESS_RPC, payload);
      if (result.error) {
        throw new Error(`readiness RPC failed: ${result.error.message}`);
      }
      const readiness = summarizeReadinessRows(
        parseReadinessRows(result.data),
        config.endDayUtc,
      );
      readinessSummary = readiness as unknown as Record<string, unknown>;
      alreadyCompleted = readiness.already_completed;
      deferred = !readiness.ready && !readiness.already_completed;

      console.log(JSON.stringify({
        level: deferred ? "warning" : "info",
        event: deferred
          ? "who_2021_readiness_deferred"
          : "who_2021_readiness_ready",
        readiness,
      }));
    }

    if (!deferred && !alreadyCompleted) {
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
    }

    if (
      !deferred && config.summaryRefreshEnabled &&
      (!alreadyCompleted || config.r2PublishEnabled)
    ) {
      const payload = buildSummaryRefreshPayload(config);
      console.log(JSON.stringify({
        level: "info",
        event: "who_2021_summary_refresh_start",
        run_mode: config.runMode,
        trigger_mode: config.triggerMode,
        already_completed: alreadyCompleted,
        ...payload,
      }));
      const result = await postgrestRpc<unknown>(
        SUMMARY_REFRESH_RPC,
        payload,
      );
      if (result.error) {
        throw new Error(
          `summary refresh RPC failed: ${result.error.message}`,
        );
      }
      summaryRefreshRows.push(...parseSummaryRefreshRows(result.data));
    }

    if (!deferred) {
      const homepageSummary = summaryRefreshRows[0]?.homepage_summary as
        | Record<string, unknown>
        | null || null;
      r2PublishSummary = await publishPhase4({
        config,
        summaryRefresh: summaryRefreshRows[0] || null,
        homepageSummary,
      });
    }
  } catch (error) {
    runStatus = "error";
    capturedError = error;
  }

  const summary = mergeDailyRefreshRows(rows);
  const summaryRefresh = summaryRefreshRows[0] || null;
  const finishedAt = new Date().toISOString();
  const summaryJson = {
    phase_3_completed: Boolean(summaryRefresh),
    deferred,
    already_completed: alreadyCompleted,
    run_mode: config.runMode,
    trigger_mode: config.triggerMode,
    source_network_code: config.sourceNetworkCode,
    connector_id: config.connectorId,
    pollutant_codes: config.pollutantCodes,
    start_day_utc: config.startDayUtc,
    end_day_utc: config.endDayUtc,
    latest_complete_day_utc: config.latestCompleteDayUtc,
    min_valid_hours_per_day: config.minValidHoursPerDay,
    min_valid_days: config.minValidDays,
    min_final_hour_coverage_ratio: config.minFinalHourCoverageRatio,
    readiness_gate_enabled: config.readinessGateEnabled,
    summary_refresh_enabled: config.summaryRefreshEnabled,
    r2_publish_enabled: config.r2PublishEnabled,
    parquet_r2_write_enabled: config.parquetR2WriteEnabled,
    r2_publish: r2PublishSummary,
    dry_run: config.dryRun,
    readiness: readinessSummary,
    rolling_rows_upserted: Number(summaryRefresh?.rolling_rows_upserted) || 0,
    calendar_rows_upserted: Number(summaryRefresh?.calendar_rows_upserted) ||
      0,
    calendar_year: summaryRefresh?.calendar_year || null,
    rolling_window_start_day_utc:
      summaryRefresh?.rolling_window_start_day_utc || null,
    rolling_window_end_day_utc: summaryRefresh?.rolling_window_end_day_utc ||
      null,
    homepage_summary: summaryRefresh?.homepage_summary || null,
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
    rollingRowsUpserted: Number(summaryRefresh?.rolling_rows_upserted) || 0,
    calendarRowsUpserted: Number(summaryRefresh?.calendar_rows_upserted) || 0,
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
