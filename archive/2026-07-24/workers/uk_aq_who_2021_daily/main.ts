import {
  addDays,
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
import {
  rowsToWho2021ParquetBytes,
  Who2021ParquetBatch,
} from "./who_2021_parquet.ts";
import {
  putR2ObjectIfChanged,
  R2Config,
  R2ObjectResult,
  sha256Hex,
} from "./r2_objects.ts";
import {
  DEFAULT_REPORT_PATH,
  OperationalOutcome,
  writeBoundedReport,
} from "./report.ts";
import { SupabaseRpcClient } from "./supabase_rpc.ts";

type RuntimeSettings = {
  client: SupabaseRpcClient;
  dailyRefreshRpc: string;
  readinessRpc: string;
  summaryRefreshRpc: string;
  parquetRowsRpc: string;
  runLogRpc: string;
  r2: R2Config | null;
  reportPath: string;
  config: ReturnType<typeof buildRunConfig>;
};

type PublishSummary = {
  checked: string[];
  updated: string[];
  unchanged: string[];
  results: R2ObjectResult[];
  bytesUpdated: number;
};

function optionalEnv(name: string): string | null {
  const value = (Deno.env.get(name) || "").trim();
  return value || null;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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

function parseRatio(
  raw: string | null | undefined,
  fallback: number,
): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function readSettings(now: Date): RuntimeSettings {
  const r2PublishEnabled = parseBoolean(
    Deno.env.get("UK_AQ_WHO_2021_R2_PUBLISH_ENABLED"),
    false,
  );
  const parquetR2WriteEnabled = parseBoolean(
    Deno.env.get("UK_AQ_WHO_2021_PARQUET_R2_WRITE_ENABLED"),
    false,
  );
  const config = buildRunConfig({
    runMode: parseRunMode(Deno.env.get("UK_AQ_WHO_2021_RUN_MODE")),
    triggerMode: parseTriggerMode(
      Deno.env.get("UK_AQ_WHO_2021_TRIGGER_MODE"),
    ),
    now,
    explicitStartDayUtc: optionalEnv("UK_AQ_WHO_2021_START_DAY_UTC"),
    explicitEndDayUtc: optionalEnv("UK_AQ_WHO_2021_END_DAY_UTC"),
    lookbackDays: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_DAILY_LOOKBACK_DAYS"),
      2,
    ),
    maturityDelayHours: 0,
    connectorId: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_CONNECTOR_ID"),
      1,
    ),
    sourceNetworkCode: optionalEnv("UK_AQ_WHO_2021_SOURCE_NETWORK_CODE") ||
      "gov_uk_aurn",
    pollutantCodes: parsePollutantCodes(
      Deno.env.get("UK_AQ_WHO_2021_POLLUTANT_CODES"),
    ),
    minValidHoursPerDay: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY"),
      18,
    ),
    minValidDays: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_MIN_VALID_DAYS"),
      274,
    ),
    minFinalHourCoverageRatio: parseRatio(
      Deno.env.get("UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO"),
      0.9,
    ),
    readinessGateEnabled: parseBoolean(
      Deno.env.get("UK_AQ_WHO_2021_READINESS_GATE_ENABLED"),
      true,
    ),
    summaryRefreshEnabled: parseBoolean(
      Deno.env.get("UK_AQ_WHO_2021_SUMMARY_REFRESH_ENABLED"),
      true,
    ),
    r2PublishEnabled,
    parquetR2WriteEnabled,
    chunkDays: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_CHUNK_DAYS"),
      31,
    ),
  });
  const endpoint = optionalEnv("R2_ENDPOINT") ||
    optionalEnv("CFLARE_R2_ENDPOINT");
  const bucket = optionalEnv("R2_BUCKET") || optionalEnv("CFLARE_R2_BUCKET");
  const accessKeyId = optionalEnv("R2_ACCESS_KEY_ID") ||
    optionalEnv("CFLARE_R2_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("R2_SECRET_ACCESS_KEY") ||
    optionalEnv("CFLARE_R2_SECRET_ACCESS_KEY");
  let r2: R2Config | null = null;
  if (r2PublishEnabled || parquetR2WriteEnabled) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "R2 publication is enabled but endpoint, bucket, access key, or secret key is missing",
      );
    }
    r2 = {
      endpoint,
      bucket,
      region: optionalEnv("R2_REGION") ||
        optionalEnv("CFLARE_R2_REGION") || "auto",
      accessKeyId,
      secretAccessKey,
    };
  }
  return {
    client: new SupabaseRpcClient(
      requiredEnv("OBS_AQIDB_SUPABASE_URL"),
      requiredEnv("OBS_AQIDB_SECRET_KEY"),
      optionalEnv("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public",
      parsePositiveInt(Deno.env.get("UK_AQ_WHO_2021_RPC_RETRIES"), 3),
    ),
    dailyRefreshRpc: optionalEnv("UK_AQ_WHO_2021_DAILY_REFRESH_RPC") ||
      "uk_aq_rpc_who_2021_daily_status_refresh",
    readinessRpc: optionalEnv("UK_AQ_WHO_2021_READINESS_RPC") ||
      "uk_aq_rpc_who_2021_readiness_check",
    summaryRefreshRpc: optionalEnv("UK_AQ_WHO_2021_SUMMARY_REFRESH_RPC") ||
      "uk_aq_rpc_who_2021_summary_refresh",
    parquetRowsRpc: "uk_aq_rpc_who_2021_r2_parquet_rows",
    runLogRpc: optionalEnv("UK_AQ_WHO_2021_RUN_LOG_RPC") ||
      "uk_aq_rpc_who_2021_processing_run_log",
    r2,
    reportPath: optionalEnv("UK_AQ_WHO_2021_REPORT_PATH") ||
      DEFAULT_REPORT_PATH,
    config,
  };
}

function parseRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? data as T[] : [];
}

function errorRecord(error: unknown): Record<string, unknown> {
  return {
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      1000,
    ),
    source_file: "workers/uk_aq_who_2021_daily/main.ts",
  };
}

function logicalRows(rows: unknown): unknown {
  if (Array.isArray(rows)) return rows.map(logicalRows);
  if (rows && typeof rows === "object") {
    const output: Record<string, unknown> = {};
    for (
      const [key, value] of Object.entries(rows as Record<string, unknown>)
    ) {
      if (key === "created_at" || key === "updated_at") continue;
      output[key] = logicalRows(value);
    }
    return output;
  }
  return rows;
}

function logicalSummary(summary: Record<string, unknown>): unknown {
  const copy = { ...summary };
  delete copy.generated_at_utc;
  return copy;
}

async function publishOutputs(args: {
  settings: RuntimeSettings;
  publicationDay: string;
  summaryRefresh: SummaryRefreshRpcRow;
  homepageSummary: Record<string, unknown>;
}): Promise<PublishSummary> {
  const { settings } = args;
  if (!settings.r2) {
    return {
      checked: [],
      updated: [],
      unchanged: [],
      results: [],
      bytesUpdated: 0,
    };
  }
  const results: R2ObjectResult[] = [];

  if (settings.config.parquetR2WriteEnabled) {
    const response = await settings.client.post<unknown>(
      settings.parquetRowsRpc,
      {
        p_as_of_day_utc: args.publicationDay,
        p_start_day_utc: settings.config.startDayUtc,
        p_end_day_utc: settings.config.endDayUtc,
        p_connector_id: settings.config.connectorId,
        p_source_network_code: settings.config.sourceNetworkCode,
        p_pollutant_codes: settings.config.pollutantCodes,
      },
    );
    if (response.error) {
      throw new Error(`parquet row RPC failed: ${response.error.message}`);
    }
    for (const batch of parseRows<Who2021ParquetBatch>(response.data)) {
      const bytes = rowsToWho2021ParquetBytes(batch);
      const logicalHash = await sha256Hex(stableJson({
        dataset: batch.dataset,
        object_key: batch.object_key,
        row_count: batch.row_count,
        rows: logicalRows(batch.rows_json),
      }));
      results.push(
        await putR2ObjectIfChanged({
          config: settings.r2,
          objectKey: batch.object_key,
          body: bytes,
          contentType: "application/vnd.apache.parquet",
          logicalHash,
        }),
      );
    }
  }

  if (settings.config.r2PublishEnabled) {
    const plan = buildR2PublishPlan({
      asOfDayUtc: args.publicationDay,
      connectorId: settings.config.connectorId,
      pollutantCodes: settings.config.pollutantCodes,
      calendarYear: args.summaryRefresh.calendar_year,
    });
    const body = stableJson(args.homepageSummary);
    const logicalHash = await sha256Hex(
      stableJson(logicalSummary(args.homepageSummary)),
    );
    results.push(
      await putR2ObjectIfChanged({
        config: settings.r2,
        objectKey: plan.datedSummaryKey,
        body,
        contentType: "application/json; charset=utf-8",
        logicalHash,
      }),
    );
    results.push(
      await putR2ObjectIfChanged({
        config: settings.r2,
        objectKey: plan.latestSummaryKey,
        body,
        contentType: "application/json; charset=utf-8",
        logicalHash,
      }),
    );
  }

  return {
    checked: results.map((result) => result.key),
    updated: results.filter((result) => result.status === "updated")
      .map((result) => result.key),
    unchanged: results.filter((result) => result.status === "unchanged")
      .map((result) => result.key),
    results,
    bytesUpdated: results.filter((result) => result.status === "updated")
      .reduce((total, result) => total + result.bytes, 0),
  };
}

async function logProcessingRun(args: {
  settings: RuntimeSettings;
  runStatus: "ok" | "error" | "dry_run";
  latestCompleteDay: string;
  dailyRows: number;
  rollingRows: number;
  calendarRows: number;
  summary: Record<string, unknown>;
  error: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string;
}): Promise<string> {
  const { config } = args.settings;
  const response = await args.settings.client.post<unknown>(
    args.settings.runLogRpc,
    {
      p_run_mode: config.runMode,
      p_trigger_mode: config.triggerMode,
      p_source_network_code: config.sourceNetworkCode,
      p_pollutant_codes: config.pollutantCodes,
      p_window_start_day_utc: config.startDayUtc,
      p_window_end_day_utc: config.endDayUtc,
      p_latest_complete_day_utc: args.latestCompleteDay,
      p_run_status: args.runStatus,
      p_daily_rows_upserted: args.dailyRows,
      p_rolling_rows_upserted: args.rollingRows,
      p_calendar_rows_upserted: args.calendarRows,
      p_summary_json: args.summary,
      p_error_json: args.error,
      p_started_at: args.startedAt,
      p_finished_at: args.finishedAt,
    },
  );
  if (response.error) {
    throw new Error(`processing run log RPC failed: ${response.error.message}`);
  }
  const first = parseRows<Record<string, unknown>>(response.data)[0];
  if (typeof first?.run_id !== "string" || !first.run_id) {
    throw new Error("processing run log RPC returned no run_id");
  }
  return first.run_id;
}

export async function runWho2021Daily(): Promise<void> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  let settings: RuntimeSettings | null = null;
  let runId: string | null = null;
  let capturedError: unknown = null;
  let readiness: Record<string, unknown> | null = null;
  let publicationDay: string | null = null;
  let latestCompleteDay: string | null = null;
  let correctionDay: string | null = null;
  let dailySummary = mergeDailyRefreshRows([]);
  let summaryRefresh: SummaryRefreshRpcRow | null = null;
  let publishSummary: PublishSummary = {
    checked: [],
    updated: [],
    unchanged: [],
    results: [],
    bytesUpdated: 0,
  };
  let outcome: OperationalOutcome = "failed";

  try {
    settings = readSettings(new Date());
    const { config } = settings;
    latestCompleteDay = config.latestCompleteDayUtc;
    correctionDay = config.runMode === "daily"
      ? addDays(latestCompleteDay, -1)
      : config.startDayUtc;
    let latestDayReady = true;

    if (shouldRunReadinessGate(config)) {
      const response = await settings.client.post<unknown>(
        settings.readinessRpc,
        buildReadinessPayload(config),
      );
      if (response.error) {
        throw new Error(`readiness RPC failed: ${response.error.message}`);
      }
      const readinessSummary = summarizeReadinessRows(
        parseRows<ReadinessRpcRow>(response.data),
        latestCompleteDay,
      );
      readiness = readinessSummary as unknown as Record<string, unknown>;
      latestDayReady = readinessSummary.ready;
      if (readinessSummary.already_completed) {
        warnings.push(
          "A prior successful run was present; recalculation continued as required.",
        );
      }
    } else {
      readiness = {
        checked: false,
        ready: true,
        as_of_day_utc: latestCompleteDay,
        pollutant_rows: [],
      };
    }
    publicationDay = config.runMode === "daily" && !latestDayReady
      ? correctionDay
      : config.endDayUtc;

    const dailyRows: DailyRefreshRpcRow[] = [];
    for (
      const chunk of buildDayChunks(
        config.startDayUtc,
        config.endDayUtc,
        config.chunkDays,
      )
    ) {
      const response = await settings.client.post<unknown>(
        settings.dailyRefreshRpc,
        buildDailyRefreshPayload(config, chunk),
      );
      if (response.error) {
        throw new Error(`daily refresh RPC failed: ${response.error.message}`);
      }
      dailyRows.push(...parseRows<DailyRefreshRpcRow>(response.data));
    }
    dailySummary = mergeDailyRefreshRows(dailyRows);

    if (config.summaryRefreshEnabled) {
      const response = await settings.client.post<unknown>(
        settings.summaryRefreshRpc,
        buildSummaryRefreshPayload(config, publicationDay),
      );
      if (response.error) {
        throw new Error(
          `summary refresh RPC failed: ${response.error.message}`,
        );
      }
      summaryRefresh = parseRows<SummaryRefreshRpcRow>(response.data)[0] ||
        null;
      if (!summaryRefresh) {
        throw new Error("summary refresh RPC returned no row");
      }
    }

    if (
      !config.dryRun &&
      (config.r2PublishEnabled || config.parquetR2WriteEnabled)
    ) {
      const homepageSummary = summaryRefresh?.homepage_summary;
      if (!summaryRefresh || !homepageSummary) {
        throw new Error(
          "R2 publication requires summary refresh and homepage_summary",
        );
      }
      publishSummary = await publishOutputs({
        settings,
        publicationDay,
        summaryRefresh,
        homepageSummary,
      });
    }

    if (config.runMode === "daily" && !latestDayReady) {
      outcome = "deferred";
    } else if (config.dryRun) {
      outcome = "unchanged";
    } else if (config.r2PublishEnabled || config.parquetR2WriteEnabled) {
      outcome = publishSummary.updated.length > 0 ? "updated" : "unchanged";
    } else {
      const changedRows = dailySummary.rows_upserted +
        (Number(summaryRefresh?.rolling_rows_upserted) || 0) +
        (Number(summaryRefresh?.calendar_rows_upserted) || 0);
      outcome = changedRows > 0 ? "updated" : "unchanged";
    }
  } catch (error) {
    capturedError = error;
    outcome = "failed";
  }

  const finishedAt = new Date().toISOString();
  const rollingRows = Number(summaryRefresh?.rolling_rows_upserted) || 0;
  const calendarRows = Number(summaryRefresh?.calendar_rows_upserted) || 0;
  const processingSummary: Record<string, unknown> = {
    phase_3_completed: Boolean(summaryRefresh),
    operational_outcome: outcome,
    publication_as_of_day_utc: publicationDay,
    correction_day_utc: correctionDay,
    readiness,
    r2_objects_checked: publishSummary.checked,
    r2_objects_updated: publishSummary.updated,
    r2_objects_unchanged: publishSummary.unchanged,
    r2_bytes_updated: publishSummary.bytesUpdated,
    homepage_summary: summaryRefresh?.homepage_summary || null,
  };

  if (settings) {
    try {
      runId = await logProcessingRun({
        settings,
        runStatus: capturedError
          ? "error"
          : settings.config.dryRun
          ? "dry_run"
          : "ok",
        latestCompleteDay: latestCompleteDay || settings.config.endDayUtc,
        dailyRows: dailySummary.rows_upserted,
        rollingRows,
        calendarRows,
        summary: processingSummary,
        error: capturedError ? errorRecord(capturedError) : null,
        startedAt,
        finishedAt,
      });
    } catch (logError) {
      if (!capturedError) {
        capturedError = logError;
      } else {
        warnings.push(
          `Processing-run logging also failed: ${
            errorRecord(logError).message
          }`,
        );
      }
      outcome = "failed";
    }
  }

  const reportPath = settings?.reportPath ||
    optionalEnv("UK_AQ_WHO_2021_REPORT_PATH") || DEFAULT_REPORT_PATH;
  const report = {
    workflow_run_id: optionalEnv("GITHUB_RUN_ID"),
    workflow_run_attempt: optionalEnv("GITHUB_RUN_ATTEMPT"),
    run_id: runId,
    run_mode: settings?.config.runMode ||
      optionalEnv("UK_AQ_WHO_2021_RUN_MODE") || "daily",
    trigger_mode: settings?.config.triggerMode ||
      optionalEnv("UK_AQ_WHO_2021_TRIGGER_MODE") || "manual",
    started_at: startedAt,
    finished_at: finishedAt,
    latest_complete_day_utc: latestCompleteDay,
    correction_day_utc: correctionDay,
    publication_as_of_day_utc: publicationDay,
    readiness,
    row_counts: {
      daily_rows_upserted: dailySummary.rows_upserted,
      rolling_rows_upserted: rollingRows,
      calendar_rows_upserted: calendarRows,
      valid_timeseries_days: dailySummary.valid_timeseries_days,
      not_enough_data_timeseries_days:
        dailySummary.not_enough_data_timeseries_days,
    },
    r2_objects_checked: publishSummary.checked,
    r2_objects_updated: publishSummary.updated,
    r2_objects_unchanged: publishSummary.unchanged,
    dropbox: {
      destination_path: null,
      upload_result: "pending",
    },
    warnings,
    operational_outcome: outcome,
    error: capturedError ? errorRecord(capturedError) : null,
  };
  try {
    await writeBoundedReport(reportPath, report);
  } catch (reportError) {
    if (!capturedError) capturedError = reportError;
    console.error(JSON.stringify({
      level: "error",
      event: "who_2021_report_write_failed",
      ...errorRecord(reportError),
    }));
  }
  console.log(JSON.stringify({
    ok: !capturedError,
    report_path: reportPath,
    ...report,
  }));
  if (capturedError) throw capturedError;
}

if (import.meta.main) {
  try {
    await runWho2021Daily();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "who_2021_daily_run_failed",
      ...errorRecord(error),
    }));
    Deno.exit(1);
  }
}
