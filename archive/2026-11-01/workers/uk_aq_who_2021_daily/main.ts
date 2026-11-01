import {
  addDays,
  buildDailyRefreshPayload,
  buildDayChunks,
  buildR2PublishPlan,
  buildReadinessPayload,
  buildRunConfig,
  buildSummaryRefreshPayload,
  DailyRefreshRpcRow,
  listDaysInclusive,
  mergeDailyRefreshRows,
  parsePollutantCodes,
  parsePositiveInt,
  parseRunMode,
  parseTriggerMode,
  PreparedUpsertRpcRow,
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
  createR2ManifestCache,
  createR2ObjectReader,
  createR2ReadMetrics,
  isAbsentR2ObservationDayManifest,
  prepareWhoDailyRowsFromR2,
  probeValidatedObservationDayManifest,
  R2ObjectReader,
  R2ObservationReadError,
  R2ObservationRow,
  R2PreparedDay,
  R2ReadMetrics,
} from "./r2_observations.ts";
import {
  DEFAULT_REPORT_PATH,
  OperationalOutcome,
  writeBoundedReport,
} from "./report.ts";
import { SupabaseRpcClient } from "./supabase_rpc.ts";

type RuntimeSettings = {
  client: SupabaseRpcClient;
  dailyRefreshRpc: string;
  preparedUpsertRpc: string;
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

const OBS_HISTORY_DAY_ROWS_RPC = "uk_aq_rpc_observs_history_day_rows";
const TIMESERIES_AQI_HOURLY_SOURCE_RPC =
  "uk_aq_rpc_timeseries_aqi_hourly_source";
const OBS_BOUNDARY_PAGE_LIMIT = 20_000;
const OBS_BOUNDARY_MAX_PAGES = 100;

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
  const runMode = parseRunMode(Deno.env.get("UK_AQ_WHO_2021_RUN_MODE"));
  const r2PublishEnabled = parseBoolean(
    Deno.env.get("UK_AQ_WHO_2021_R2_PUBLISH_ENABLED"),
    false,
  );
  const parquetR2WriteEnabled = parseBoolean(
    Deno.env.get("UK_AQ_WHO_2021_PARQUET_R2_WRITE_ENABLED"),
    false,
  );
  const config = buildRunConfig({
    runMode,
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
      runMode === "daily",
    ),
    r2PublishEnabled,
    parquetR2WriteEnabled,
    chunkDays: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_CHUNK_DAYS"),
      31,
    ),
    backfillMaxDays: parsePositiveInt(
      Deno.env.get("UK_AQ_WHO_2021_R2_BACKFILL_MAX_DAYS"),
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
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    r2 = {
      endpoint,
      bucket,
      region: optionalEnv("R2_REGION") ||
        optionalEnv("CFLARE_R2_REGION") || "auto",
      accessKeyId,
      secretAccessKey,
    };
  } else if (
    runMode === "backfill" || r2PublishEnabled || parquetR2WriteEnabled
  ) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "R2 access is required but endpoint, bucket, access key, or secret key is missing",
      );
    }
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
    preparedUpsertRpc: optionalEnv("UK_AQ_WHO_2021_PREPARED_UPSERT_RPC") ||
      "uk_aq_rpc_who_2021_daily_status_upsert_prepared",
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
  usableDailyPublicationDays: string[];
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
        p_end_day_utc: args.publicationDay,
        p_connector_id: settings.config.connectorId,
        p_source_network_code: settings.config.sourceNetworkCode,
        p_pollutant_codes: settings.config.pollutantCodes,
      },
    );
    if (response.error) {
      throw new Error(`parquet row RPC failed: ${response.error.message}`);
    }
    const usableDailyPublicationDays = new Set(
      args.usableDailyPublicationDays,
    );
    for (const batch of parseRows<Who2021ParquetBatch>(response.data)) {
      if (batch.dataset === "daily_status") {
        const dayUtc = batch.object_key.match(
          /\/daily_status\/day_utc=(\d{4}-\d{2}-\d{2})\//,
        )?.[1];
        if (!dayUtc) {
          throw new Error(
            `daily parquet batch has an invalid object key: ${
              batch.object_key.slice(0, 300)
            }`,
          );
        }
        if (!usableDailyPublicationDays.has(dayUtc)) continue;
      }
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

type DailySourceMode = "obs_aqidb" | "r2_v2" | "unavailable";

type DailySourceResult = {
  day_utc: string;
  source: DailySourceMode;
  boundary_source: "obs_aqidb" | "r2_v2" | null;
  calculation_status: "usable" | "unusable" | "failed";
  valid_timeseries_days: number;
  not_enough_data_timeseries_days: number;
  rows_upserted: number;
  prepared_daily_row_count: number;
  reasons: string[];
  error: string | null;
};

export function selectNewestUsablePublicationDay(
  results: Array<
    Pick<
      DailySourceResult,
      "day_utc" | "source" | "valid_timeseries_days"
    >
  >,
): string | null {
  return [...results]
    .filter((result) =>
      result.source !== "unavailable" &&
      Number(result.valid_timeseries_days) > 0
    )
    .sort((left, right) => right.day_utc.localeCompare(left.day_utc))[0]
    ?.day_utc || null;
}

type R2RunEvidence = {
  manifestKeys: Set<string>;
  manifestHashesValidated: number;
  parquetHashesValidated: number;
  objectCount: number;
  bytesRead: number;
  parquetRowCount: number;
  preparedDailyRowCount: number;
};

class R2PreparedRpcError extends Error {
  constructor(message: string, readonly prepared: R2PreparedDay) {
    super(message);
    this.name = "R2PreparedRpcError";
  }
}

class ObsBackfillSourceError extends Error {
  constructor(
    message: string,
    readonly metrics: R2ReadMetrics,
    readonly reason: "database_full_day_failed" | "database_boundary_failed",
  ) {
    super(message);
    this.name = "ObsBackfillSourceError";
  }
}

function emptyR2RunEvidence(): R2RunEvidence {
  return {
    manifestKeys: new Set(),
    manifestHashesValidated: 0,
    parquetHashesValidated: 0,
    objectCount: 0,
    bytesRead: 0,
    parquetRowCount: 0,
    preparedDailyRowCount: 0,
  };
}

function accumulateR2Evidence(
  evidence: R2RunEvidence,
  metrics: R2ReadMetrics,
  preparedRowCount: number,
): void {
  for (const key of metrics.manifestKeys) evidence.manifestKeys.add(key);
  evidence.manifestHashesValidated += metrics.manifestHashesValidated;
  evidence.parquetHashesValidated += metrics.parquetHashesValidated;
  evidence.objectCount += metrics.objectCount;
  evidence.bytesRead += metrics.bytesRead;
  evidence.parquetRowCount += metrics.parquetRowCount;
  evidence.preparedDailyRowCount += preparedRowCount;
}

function preparedRowAsDailyRefresh(
  row: PreparedUpsertRpcRow,
): DailyRefreshRpcRow {
  return {
    start_day_utc: row.day_utc,
    end_day_utc: row.day_utc,
    connector_id: row.connector_id,
    source_network_code: row.source_network_code,
    pollutant_codes: row.pollutant_codes,
    candidate_timeseries_count: Number(row.candidate_timeseries_count) || 0,
    candidate_timeseries_days: Number(row.candidate_timeseries_days) || 0,
    source_hour_rows: Number(row.source_hour_rows) || 0,
    valid_timeseries_days: Number(row.valid_timeseries_days) || 0,
    not_enough_data_timeseries_days:
      Number(row.not_enough_data_timeseries_days) || 0,
    rows_upserted: Number(row.rows_upserted) || 0,
    dry_run: Boolean(row.dry_run),
  };
}

async function refreshObsDay(
  settings: RuntimeSettings,
  dayUtc: string,
): Promise<DailyRefreshRpcRow> {
  const response = await settings.client.post<unknown>(
    settings.dailyRefreshRpc,
    buildDailyRefreshPayload(settings.config, {
      startDayUtc: dayUtc,
      endDayUtc: dayUtc,
    }),
  );
  if (response.error) {
    throw new Error(`daily refresh RPC failed: ${response.error.message}`);
  }
  const row = parseRows<DailyRefreshRpcRow>(response.data)[0];
  if (!row) throw new Error(`daily refresh RPC returned no row for ${dayUtc}`);
  return row;
}

type ObsHistoryRow = {
  timeseriesId: number;
  observedAtUtc: string;
  value: number | null;
};

function parseObsHistoryRows(
  payload: unknown,
  dayUtc: string,
): ObsHistoryRow[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      `Obs AQI DB history RPC returned no row array for ${dayUtc}`,
    );
  }
  const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return payload.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Obs AQI DB history RPC row ${index} is not an object for ${dayUtc}`,
      );
    }
    const row = value as Record<string, unknown>;
    const timeseriesId = Number(row.timeseries_id);
    const observedMs = Date.parse(String(row.observed_at || ""));
    const numericValue = row.value === null || row.value === undefined
      ? null
      : Number(row.value);
    if (
      !Number.isSafeInteger(timeseriesId) ||
      timeseriesId <= 0 ||
      !Number.isFinite(observedMs) ||
      observedMs < startMs ||
      observedMs >= endMs ||
      (numericValue !== null && !Number.isFinite(numericValue))
    ) {
      throw new Error(
        `Obs AQI DB history RPC row ${index} is invalid for ${dayUtc}`,
      );
    }
    return {
      timeseriesId,
      observedAtUtc: new Date(observedMs).toISOString(),
      value: numericValue,
    };
  });
}

function compareObsHistoryRows(
  left: Pick<ObsHistoryRow, "timeseriesId" | "observedAtUtc">,
  right: Pick<ObsHistoryRow, "timeseriesId" | "observedAtUtc">,
): number {
  if (left.timeseriesId !== right.timeseriesId) {
    return left.timeseriesId - right.timeseriesId;
  }
  return left.observedAtUtc.localeCompare(right.observedAtUtc);
}

async function readObsBoundaryRows(
  settings: RuntimeSettings,
  boundaryDayUtc: string,
): Promise<R2ObservationRow[]> {
  const boundaryAt = `${boundaryDayUtc}T00:00:00.000Z`;
  let cursor: Pick<ObsHistoryRow, "timeseriesId" | "observedAtUtc"> | null =
    null;
  const exactRows: ObsHistoryRow[] = [];

  for (let page = 0; page < OBS_BOUNDARY_MAX_PAGES; page += 1) {
    const response = await settings.client.post<unknown>(
      OBS_HISTORY_DAY_ROWS_RPC,
      {
        p_day_utc: boundaryDayUtc,
        p_connector_id: settings.config.connectorId,
        p_after_timeseries_id: cursor?.timeseriesId || null,
        p_after_observed_at: cursor?.observedAtUtc || null,
        p_limit: OBS_BOUNDARY_PAGE_LIMIT,
      },
    );
    if (response.error) {
      throw new Error(
        `Obs AQI DB boundary history RPC failed for ${boundaryDayUtc}: ${response.error.message}`,
      );
    }
    const rows = parseObsHistoryRows(response.data, boundaryDayUtc);
    if (!rows.length) {
      return await identifyObsBoundaryRows(
        settings,
        boundaryAt,
        exactRows,
      );
    }
    for (const row of rows) {
      if (cursor && compareObsHistoryRows(row, cursor) <= 0) {
        throw new Error(
          `Obs AQI DB boundary history RPC did not advance for ${boundaryDayUtc}`,
        );
      }
      cursor = row;
      if (row.observedAtUtc === boundaryAt) exactRows.push(row);
    }
    if (rows.length < OBS_BOUNDARY_PAGE_LIMIT) {
      return await identifyObsBoundaryRows(settings, boundaryAt, exactRows);
    }
  }
  throw new Error(
    `Obs AQI DB boundary history RPC exceeded ${OBS_BOUNDARY_MAX_PAGES} pages for ${boundaryDayUtc}`,
  );
}

async function identifyObsBoundaryRows(
  settings: RuntimeSettings,
  boundaryAt: string,
  rows: ObsHistoryRow[],
): Promise<R2ObservationRow[]> {
  const timeseriesIds = [...new Set(rows.map((row) => row.timeseriesId))];
  if (!timeseriesIds.length) return [];
  const boundaryEnd = new Date(Date.parse(boundaryAt) + 60 * 60 * 1000)
    .toISOString();
  const response = await settings.client.post<unknown>(
    TIMESERIES_AQI_HOURLY_SOURCE_RPC,
    {
      p_window_start: boundaryAt,
      p_window_end: boundaryEnd,
      p_timeseries_ids: timeseriesIds,
    },
  );
  if (response.error) {
    throw new Error(
      `Obs AQI DB boundary identity RPC failed for ${boundaryAt}: ${response.error.message}`,
    );
  }
  if (!Array.isArray(response.data)) {
    throw new Error(
      `Obs AQI DB boundary identity RPC returned no row array for ${boundaryAt}`,
    );
  }

  const identities = new Map<
    number,
    { stationId: number | null; pollutantCode: string }
  >();
  for (const [index, value] of response.data.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Obs AQI DB boundary identity row ${index} is not an object for ${boundaryAt}`,
      );
    }
    const row = value as Record<string, unknown>;
    const timeseriesId = Number(row.timeseries_id);
    const connectorId = Number(row.connector_id);
    const pollutantCode = String(row.pollutant_code || "").trim()
      .toLowerCase();
    const timestampMs = Date.parse(String(row.timestamp_hour_utc || ""));
    const stationId = row.station_id === null || row.station_id === undefined
      ? null
      : Number(row.station_id);
    if (
      !Number.isSafeInteger(timeseriesId) ||
      timeseriesId <= 0 ||
      !Number.isSafeInteger(connectorId) ||
      !Number.isFinite(timestampMs) ||
      new Date(timestampMs).toISOString() !== boundaryAt ||
      (
        stationId !== null &&
        (!Number.isSafeInteger(stationId) || stationId <= 0)
      )
    ) {
      throw new Error(
        `Obs AQI DB boundary identity row ${index} is invalid for ${boundaryAt}`,
      );
    }
    if (
      connectorId !== settings.config.connectorId ||
      !settings.config.pollutantCodes.includes(pollutantCode)
    ) {
      continue;
    }
    const existing = identities.get(timeseriesId);
    if (
      existing &&
      (
        existing.stationId !== stationId ||
        existing.pollutantCode !== pollutantCode
      )
    ) {
      throw new Error(
        `Obs AQI DB boundary identity is contradictory for timeseries_id ${timeseriesId}`,
      );
    }
    identities.set(timeseriesId, { stationId, pollutantCode });
  }

  return rows.flatMap((row) => {
    const identity = identities.get(row.timeseriesId);
    if (!identity) return [];
    return [{
      connectorId: settings.config.connectorId,
      stationId: identity.stationId,
      timeseriesId: row.timeseriesId,
      pollutantCode: identity.pollutantCode,
      observedAtUtc: boundaryAt,
      value: row.value,
    }];
  });
}

async function readinessForDay(
  settings: RuntimeSettings,
  dayUtc: string,
): Promise<ReturnType<typeof summarizeReadinessRows>> {
  const response = await settings.client.post<unknown>(
    settings.readinessRpc,
    buildReadinessPayload(settings.config, dayUtc),
  );
  if (response.error) {
    throw new Error(`readiness RPC failed: ${response.error.message}`);
  }
  return summarizeReadinessRows(
    parseRows<ReadinessRpcRow>(response.data),
    dayUtc,
  );
}

async function refreshR2Day(
  settings: RuntimeSettings,
  dayUtc: string,
): Promise<{ prepared: R2PreparedDay; rpc: DailyRefreshRpcRow }> {
  if (!settings.r2) {
    throw new Error("R2 fallback is unavailable because R2 is not configured");
  }
  const prepared = await prepareWhoDailyRowsFromR2({
    readObject: createR2ObjectReader(settings.r2),
    dayUtc,
    connectorId: settings.config.connectorId,
    pollutantCodes: settings.config.pollutantCodes,
    minValidHoursPerDay: settings.config.minValidHoursPerDay,
  });
  return {
    prepared,
    rpc: await upsertPreparedDay(settings, dayUtc, prepared),
  };
}

async function upsertPreparedDay(
  settings: RuntimeSettings,
  dayUtc: string,
  prepared: R2PreparedDay,
): Promise<DailyRefreshRpcRow> {
  const response = await settings.client.post<unknown>(
    settings.preparedUpsertRpc,
    {
      p_day_utc: dayUtc,
      p_connector_id: settings.config.connectorId,
      p_source_network_code: settings.config.sourceNetworkCode,
      p_pollutant_codes: settings.config.pollutantCodes,
      p_min_valid_hours_per_day: settings.config.minValidHoursPerDay,
      p_prepared_rows: prepared.preparedRows,
      p_dry_run: settings.config.dryRun,
    },
  );
  if (response.error) {
    throw new R2PreparedRpcError(
      `prepared upsert RPC failed: ${response.error.message}`,
      prepared,
    );
  }
  const row = parseRows<PreparedUpsertRpcRow>(response.data)[0];
  if (!row) {
    throw new R2PreparedRpcError(
      `prepared upsert RPC returned no row for ${dayUtc}`,
      prepared,
    );
  }
  return preparedRowAsDailyRefresh(row);
}

export async function runWho2021Daily(): Promise<void> {
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  let settings: RuntimeSettings | null = null;
  let runId: string | null = null;
  let capturedError: unknown = null;
  const readinessByDay: Record<string, unknown> = {};
  const dailySources: DailySourceResult[] = [];
  const completedDays: string[] = [];
  const dailyRows: DailyRefreshRpcRow[] = [];
  const r2Evidence = emptyR2RunEvidence();
  let failedDay: string | null = null;
  let r2ValidationFailed = false;
  let publicationDay: string | null = null;
  let publicationDecisionReason: string | null = null;
  let latestCompleteDay: string | null = null;
  let correctionDay: string | null = null;
  let dailySummary = mergeDailyRefreshRows([]);
  let summaryRefresh: SummaryRefreshRpcRow | null = null;
  let summaryRefreshCompleted = false;
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

    if (config.runMode === "backfill") {
      for (
        const dayUtc of listDaysInclusive(
          config.startDayUtc,
          config.endDayUtc,
        )
      ) {
        const metrics = createR2ReadMetrics();
        const manifestCache = createR2ManifestCache();
        let attemptedTargetSource: DailySourceMode = "unavailable";
        let attemptedBoundarySource: "obs_aqidb" | "r2_v2" | null = null;
        try {
          if (!settings.r2) {
            throw new Error(
              "R2 source selection is unavailable because R2 is not configured",
            );
          }
          const readObject: R2ObjectReader = createR2ObjectReader(settings.r2);
          attemptedTargetSource = "r2_v2";
          try {
            await probeValidatedObservationDayManifest({
              readObject,
              dayUtc,
              metrics,
              manifestCache,
            });
          } catch (error) {
            if (isAbsentR2ObservationDayManifest(error, dayUtc)) {
              attemptedTargetSource = "obs_aqidb";
              attemptedBoundarySource = "obs_aqidb";
              let row: DailyRefreshRpcRow;
              try {
                row = await refreshObsDay(settings, dayUtc);
              } catch (databaseError) {
                throw new ObsBackfillSourceError(
                  `Obs AQI DB full-day source failed for ${dayUtc}: ${
                    String(
                      databaseError instanceof Error
                        ? databaseError.message
                        : databaseError,
                    ).slice(0, 320)
                  }`,
                  metrics,
                  "database_full_day_failed",
                );
              }
              dailyRows.push(row);
              completedDays.push(dayUtc);
              dailySources.push({
                day_utc: dayUtc,
                source: "obs_aqidb",
                boundary_source: "obs_aqidb",
                calculation_status: row.valid_timeseries_days > 0
                  ? "usable"
                  : "unusable",
                valid_timeseries_days: row.valid_timeseries_days,
                not_enough_data_timeseries_days:
                  row.not_enough_data_timeseries_days,
                rows_upserted: row.rows_upserted,
                prepared_daily_row_count: 0,
                reasons: row.valid_timeseries_days > 0
                  ? [
                    "r2_target_manifest_absent",
                    "database_backfill_used",
                  ]
                  : [
                    "r2_target_manifest_absent",
                    "database_backfill_zero_valid_days",
                  ],
                error: null,
              });
              continue;
            }
            throw new R2ObservationReadError(
              `WHO target day manifest ${dayUtc} failed validation: ${
                String(error instanceof Error ? error.message : error).slice(
                  0,
                  320,
                )
              }`,
              {
                ...metrics,
                manifestKeys: [...new Set(metrics.manifestKeys)],
              },
            );
          }

          const boundaryDayUtc = addDays(dayUtc, 1);
          let boundarySource: "r2_v2" | "obs_aqidb" = "r2_v2";
          attemptedBoundarySource = boundarySource;
          let boundaryRows: R2ObservationRow[] | undefined;
          try {
            await probeValidatedObservationDayManifest({
              readObject,
              dayUtc: boundaryDayUtc,
              metrics,
              manifestCache,
            });
          } catch (error) {
            if (isAbsentR2ObservationDayManifest(error, boundaryDayUtc)) {
              boundarySource = "obs_aqidb";
              attemptedBoundarySource = boundarySource;
              try {
                boundaryRows = await readObsBoundaryRows(
                  settings,
                  boundaryDayUtc,
                );
              } catch (boundaryError) {
                throw new ObsBackfillSourceError(
                  `Obs AQI DB boundary source failed for ${boundaryDayUtc}: ${
                    String(
                      boundaryError instanceof Error
                        ? boundaryError.message
                        : boundaryError,
                    ).slice(0, 320)
                  }`,
                  metrics,
                  "database_boundary_failed",
                );
              }
            } else {
              throw new R2ObservationReadError(
                `WHO boundary day manifest ${boundaryDayUtc} failed validation: ${
                  String(error instanceof Error ? error.message : error).slice(
                    0,
                    320,
                  )
                }`,
                {
                  ...metrics,
                  manifestKeys: [...new Set(metrics.manifestKeys)],
                },
              );
            }
          }

          const prepared = await prepareWhoDailyRowsFromR2({
            readObject,
            dayUtc,
            connectorId: settings.config.connectorId,
            pollutantCodes: settings.config.pollutantCodes,
            minValidHoursPerDay: settings.config.minValidHoursPerDay,
            boundaryRows,
            metrics,
            manifestCache,
          });
          const rpc = await upsertPreparedDay(settings, dayUtc, prepared);
          dailyRows.push(rpc);
          accumulateR2Evidence(
            r2Evidence,
            prepared.metrics,
            prepared.preparedRows.length,
          );
          completedDays.push(dayUtc);
          dailySources.push({
            day_utc: dayUtc,
            source: "r2_v2",
            boundary_source: boundarySource,
            calculation_status: rpc.valid_timeseries_days > 0
              ? "usable"
              : "unusable",
            valid_timeseries_days: rpc.valid_timeseries_days,
            not_enough_data_timeseries_days:
              rpc.not_enough_data_timeseries_days,
            rows_upserted: rpc.rows_upserted,
            prepared_daily_row_count: prepared.preparedRows.length,
            reasons: rpc.valid_timeseries_days > 0
              ? [
                "r2_target_used",
                boundarySource === "r2_v2"
                  ? "r2_boundary_used"
                  : "database_boundary_used",
              ]
              : [
                "r2_target_used",
                boundarySource === "r2_v2"
                  ? "r2_boundary_used"
                  : "database_boundary_used",
                "backfill_zero_valid_days",
              ],
            error: null,
          });
        } catch (error) {
          failedDay = dayUtc;
          if (error instanceof R2PreparedRpcError) {
            accumulateR2Evidence(
              r2Evidence,
              error.prepared.metrics,
              error.prepared.preparedRows.length,
            );
          } else if (error instanceof R2ObservationReadError) {
            accumulateR2Evidence(r2Evidence, error.metrics, 0);
            r2ValidationFailed = true;
          } else if (error instanceof ObsBackfillSourceError) {
            accumulateR2Evidence(r2Evidence, error.metrics, 0);
          } else {
            r2ValidationFailed = true;
          }
          dailySources.push({
            day_utc: dayUtc,
            source: attemptedTargetSource,
            boundary_source: attemptedBoundarySource,
            calculation_status: "failed",
            valid_timeseries_days: 0,
            not_enough_data_timeseries_days: 0,
            rows_upserted: 0,
            prepared_daily_row_count: 0,
            reasons: error instanceof ObsBackfillSourceError
              ? [error.reason]
              : ["r2_backfill_failed"],
            error: String(error instanceof Error ? error.message : error)
              .slice(0, 500),
          });
          throw error;
        }
      }
      publicationDay = selectNewestUsablePublicationDay(dailySources);
      if (!publicationDay) {
        publicationDecisionReason = "no_usable_backfill_publication_day";
        warnings.push(
          "Backfill completed without a usable publication day; publication-dependent summaries and R2 outputs were skipped.",
        );
      } else if (publicationDay !== config.endDayUtc) {
        publicationDecisionReason =
          "backfill_end_day_unusable_selected_newest_usable_day";
      }
    } else if (config.runMode === "daily") {
      for (
        const dayUtc of listDaysInclusive(
          config.startDayUtc,
          config.endDayUtc,
        )
      ) {
        let readinessReady = false;
        const sourceReasons: string[] = [];
        try {
          const dayReadiness = shouldRunReadinessGate(config)
            ? await readinessForDay(settings, dayUtc)
            : {
              checked: false,
              ready: true,
              already_completed: false,
              as_of_day_utc: dayUtc,
              final_hour_observed_at: null,
              pollutant_rows: [],
            };
          readinessByDay[dayUtc] = dayReadiness;
          readinessReady = dayReadiness.ready;
          if (!readinessReady) sourceReasons.push("database_not_ready");
          if (dayReadiness.already_completed) {
            warnings.push(
              `A prior successful run covered ${dayUtc}; recalculation continued as required.`,
            );
          }
        } catch (error) {
          readinessByDay[dayUtc] = {
            checked: true,
            ready: false,
            error: errorRecord(error),
          };
          warnings.push(
            `Obs AQI DB readiness was unavailable for ${dayUtc}; exact-day R2 fallback was attempted.`,
          );
          sourceReasons.push("database_readiness_failed");
        }

        if (readinessReady) {
          try {
            const row = await refreshObsDay(settings, dayUtc);
            if (row.valid_timeseries_days > 0) {
              dailyRows.push(row);
              completedDays.push(dayUtc);
              dailySources.push({
                day_utc: dayUtc,
                source: "obs_aqidb",
                boundary_source: "obs_aqidb",
                calculation_status: "usable",
                valid_timeseries_days: row.valid_timeseries_days,
                not_enough_data_timeseries_days:
                  row.not_enough_data_timeseries_days,
                rows_upserted: row.rows_upserted,
                prepared_daily_row_count: 0,
                reasons: ["database_used"],
                error: null,
              });
              continue;
            }
            sourceReasons.push("database_ready_but_zero_valid_days");
            warnings.push(
              `Obs AQI DB refresh returned zero valid timeseries days for ${dayUtc}; exact-day R2 fallback was attempted.`,
            );
          } catch (error) {
            sourceReasons.push("database_refresh_failed");
            warnings.push(
              `Obs AQI DB refresh failed for ${dayUtc}; exact-day R2 fallback was attempted: ${
                String(error instanceof Error ? error.message : error).slice(
                  0,
                  300,
                )
              }`,
            );
          }
        }

        try {
          const result = await refreshR2Day(settings, dayUtc);
          accumulateR2Evidence(
            r2Evidence,
            result.prepared.metrics,
            result.prepared.preparedRows.length,
          );
          if (result.rpc.valid_timeseries_days > 0) {
            dailyRows.push(result.rpc);
            completedDays.push(dayUtc);
            dailySources.push({
              day_utc: dayUtc,
              source: "r2_v2",
              boundary_source: "r2_v2",
              calculation_status: "usable",
              valid_timeseries_days: result.rpc.valid_timeseries_days,
              not_enough_data_timeseries_days:
                result.rpc.not_enough_data_timeseries_days,
              rows_upserted: result.rpc.rows_upserted,
              prepared_daily_row_count: result.prepared.preparedRows.length,
              reasons: [...sourceReasons, "r2_fallback_used"],
              error: null,
            });
          } else {
            dailySources.push({
              day_utc: dayUtc,
              source: "unavailable",
              boundary_source: "r2_v2",
              calculation_status: "unusable",
              valid_timeseries_days: 0,
              not_enough_data_timeseries_days:
                result.rpc.not_enough_data_timeseries_days,
              rows_upserted: result.rpc.rows_upserted,
              prepared_daily_row_count: result.prepared.preparedRows.length,
              reasons: [
                ...sourceReasons,
                "r2_fallback_zero_valid_days",
              ],
              error: null,
            });
            warnings.push(
              `R2 fallback returned zero valid timeseries days for ${dayUtc}; the calculated day is unusable and was not selected for publication.`,
            );
          }
        } catch (error) {
          if (error instanceof R2PreparedRpcError) {
            accumulateR2Evidence(
              r2Evidence,
              error.prepared.metrics,
              error.prepared.preparedRows.length,
            );
          } else if (error instanceof R2ObservationReadError) {
            accumulateR2Evidence(r2Evidence, error.metrics, 0);
            r2ValidationFailed = true;
          } else {
            r2ValidationFailed = true;
          }
          const message = String(
            error instanceof Error ? error.message : error,
          ).slice(0, 500);
          dailySources.push({
            day_utc: dayUtc,
            source: "unavailable",
            boundary_source: null,
            calculation_status: sourceReasons.includes(
                "database_ready_but_zero_valid_days",
              )
              ? "unusable"
              : "failed",
            valid_timeseries_days: 0,
            not_enough_data_timeseries_days: 0,
            rows_upserted: 0,
            prepared_daily_row_count: 0,
            reasons: [...sourceReasons, "r2_fallback_failed"],
            error: message,
          });
          warnings.push(`No usable source for ${dayUtc}: ${message}`);
        }
      }
      publicationDay = selectNewestUsablePublicationDay(dailySources);
      if (!publicationDay) {
        publicationDecisionReason = "no_usable_daily_publication_day";
      }
    } else {
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
          throw new Error(
            `daily refresh RPC failed: ${response.error.message}`,
          );
        }
        const rows = parseRows<DailyRefreshRpcRow>(response.data);
        dailyRows.push(...rows);
        for (const row of rows) {
          dailySources.push({
            day_utc: row.end_day_utc,
            source: "obs_aqidb",
            boundary_source: "obs_aqidb",
            calculation_status: Number(row.valid_timeseries_days) > 0
              ? "usable"
              : "unusable",
            valid_timeseries_days: Number(row.valid_timeseries_days) || 0,
            not_enough_data_timeseries_days:
              Number(row.not_enough_data_timeseries_days) || 0,
            rows_upserted: Number(row.rows_upserted) || 0,
            prepared_daily_row_count: 0,
            reasons: ["database_used"],
            error: null,
          });
        }
      }
      publicationDay = config.endDayUtc;
    }
    dailySummary = mergeDailyRefreshRows(dailyRows);

    if (config.summaryRefreshEnabled && publicationDay) {
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
      summaryRefreshCompleted = true;
    }

    if (
      !config.dryRun &&
      publicationDay &&
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
        usableDailyPublicationDays: dailySources
          .filter((result) =>
            result.source !== "unavailable" &&
            result.valid_timeseries_days > 0
          )
          .map((result) => result.day_utc),
        summaryRefresh,
        homepageSummary,
      });
    }

    if (
      (config.runMode === "daily" || config.runMode === "backfill") &&
      !publicationDay
    ) {
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

  dailySummary = mergeDailyRefreshRows(dailyRows);
  const finishedAt = new Date().toISOString();
  const rollingRows = Number(summaryRefresh?.rolling_rows_upserted) || 0;
  const calendarRows = Number(summaryRefresh?.calendar_rows_upserted) || 0;
  const processingSummary: Record<string, unknown> = {
    phase_3_completed: Boolean(summaryRefresh),
    operational_outcome: outcome,
    publication_as_of_day_utc: publicationDay,
    publication_decision_reason: publicationDecisionReason,
    publication_eligible_days: dailySources
      .filter((result) =>
        result.source !== "unavailable" &&
        result.valid_timeseries_days > 0
      )
      .map((result) => result.day_utc),
    correction_day_utc: correctionDay,
    readiness: readinessByDay,
    source_mode: settings?.config.runMode === "backfill"
      ? "source_aware_backfill"
      : "source_priority",
    daily_sources: dailySources,
    completed_days: completedDays,
    last_completed_day: completedDays.at(-1) || null,
    failed_day: failedDay,
    summary_refresh_requested: Boolean(
      settings?.config.summaryRefreshEnabled,
    ),
    summary_refresh_completed: summaryRefreshCompleted,
    r2_manifest_keys: [...r2Evidence.manifestKeys],
    r2_manifest_hashes_validated: r2Evidence.manifestHashesValidated,
    r2_parquet_hashes_validated: r2Evidence.parquetHashesValidated,
    r2_validation_result: r2ValidationFailed
      ? "failed"
      : r2Evidence.objectCount > 0
      ? "passed"
      : "not_run",
    r2_object_count: r2Evidence.objectCount,
    r2_bytes_read: r2Evidence.bytesRead,
    r2_parquet_row_count: r2Evidence.parquetRowCount,
    prepared_daily_row_count: r2Evidence.preparedDailyRowCount,
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
    publication_decision_reason: publicationDecisionReason,
    publication_eligible_days: dailySources
      .filter((result) =>
        result.source !== "unavailable" &&
        result.valid_timeseries_days > 0
      )
      .map((result) => result.day_utc),
    requested_start_day_utc: settings?.config.startDayUtc || null,
    requested_end_day_utc: settings?.config.endDayUtc || null,
    completed_days: completedDays,
    last_completed_day: completedDays.at(-1) || null,
    failed_day: failedDay,
    source_mode: settings?.config.runMode === "backfill"
      ? "source_aware_backfill"
      : "source_priority",
    daily_sources: dailySources,
    readiness: readinessByDay,
    manifest_keys_used: [...r2Evidence.manifestKeys],
    manifest_hash_validation: {
      manifests_validated: r2Evidence.manifestHashesValidated,
      parquet_objects_validated: r2Evidence.parquetHashesValidated,
      result: r2ValidationFailed
        ? "failed"
        : r2Evidence.objectCount > 0
        ? "passed"
        : "not_run",
    },
    r2_object_count: r2Evidence.objectCount,
    r2_bytes_read: r2Evidence.bytesRead,
    parquet_row_count: r2Evidence.parquetRowCount,
    prepared_daily_row_count: r2Evidence.preparedDailyRowCount,
    summary_refresh_requested: Boolean(
      settings?.config.summaryRefreshEnabled,
    ),
    summary_refresh_completed: summaryRefreshCompleted,
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
