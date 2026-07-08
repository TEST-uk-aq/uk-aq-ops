export type RunMode = "daily" | "backfill" | "dry_run";
export type TriggerMode = "scheduler" | "manual" | "test";

export type RunConfig = {
  runMode: RunMode;
  triggerMode: TriggerMode;
  startDayUtc: string;
  endDayUtc: string;
  latestCompleteDayUtc: string;
  connectorId: number;
  sourceNetworkCode: string;
  pollutantCodes: string[];
  minValidHoursPerDay: number;
  minValidDays: number;
  minFinalHourCoverageRatio: number;
  readinessGateEnabled: boolean;
  summaryRefreshEnabled: boolean;
  r2PublishEnabled?: boolean;
  parquetExportEnabled?: boolean;
  chunkDays: number;
  dryRun: boolean;
};

export type DailyRefreshRpcPayload = {
  p_start_day_utc: string;
  p_end_day_utc: string;
  p_connector_id: number;
  p_source_network_code: string;
  p_pollutant_codes: string[];
  p_min_valid_hours_per_day: number;
  p_dry_run: boolean;
};

export type DailyRefreshRpcRow = {
  start_day_utc: string;
  end_day_utc: string;
  connector_id: number;
  source_network_code: string;
  pollutant_codes: string[];
  candidate_timeseries_count: number;
  candidate_timeseries_days: number;
  source_hour_rows: number;
  valid_timeseries_days: number;
  not_enough_data_timeseries_days: number;
  rows_upserted: number;
  dry_run: boolean;
};

export type ReadinessRpcPayload = {
  p_as_of_day_utc: string;
  p_connector_id: number;
  p_source_network_code: string;
  p_pollutant_codes: string[];
  p_min_final_hour_coverage_ratio: number;
};

export type ReadinessRpcRow = {
  as_of_day_utc: string;
  connector_id: number;
  source_network_code: string;
  pollutant_code: string;
  eligible_timeseries_count: number;
  final_hour_timeseries_count: number;
  final_hour_coverage_ratio: number;
  final_hour_observed_at: string;
  pollutant_ready: boolean;
  all_pollutants_ready: boolean;
  already_completed: boolean;
};

export type ReadinessSummary = {
  checked: boolean;
  ready: boolean;
  already_completed: boolean;
  as_of_day_utc: string;
  final_hour_observed_at: string | null;
  pollutant_rows: ReadinessRpcRow[];
};

export type SummaryRefreshRpcPayload = {
  p_as_of_day_utc: string;
  p_connector_id: number;
  p_source_network_code: string;
  p_pollutant_codes: string[];
  p_min_valid_days: number;
  p_min_valid_hours_per_day: number;
  p_dry_run: boolean;
};

export type SummaryRefreshRpcRow = {
  as_of_day_utc: string;
  connector_id: number;
  source_network_code: string;
  pollutant_codes: string[];
  rolling_window_start_day_utc: string;
  rolling_window_end_day_utc: string;
  calendar_year: number;
  rolling_rows_upserted: number;
  calendar_rows_upserted: number;
  homepage_summary: Record<string, unknown> | null;
  dry_run: boolean;
};

export type R2PublishPlan = {
  datedSummaryKey: string;
  latestSummaryKey: string;
  dailyCacheQuery: string;
  parquetPrefixes: {
    dailyStatus: string;
    rollingYearStatus: string;
    calendarYearStatus: string;
  };
};

export type DailyRefreshSummary = {
  chunks: number;
  candidate_timeseries_count: number;
  candidate_timeseries_days: number;
  source_hour_rows: number;
  valid_timeseries_days: number;
  not_enough_data_timeseries_days: number;
  rows_upserted: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRunMode(raw: string | null | undefined): RunMode {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "backfill" || value === "dry_run") return value;
  return "daily";
}

export function parseTriggerMode(raw: string | null | undefined): TriggerMode {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "scheduler" || value === "test") return value;
  return "manual";
}

export function parsePositiveInt(
  raw: string | null | undefined,
  fallback: number,
): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

export function parsePollutantCodes(raw: string | null | undefined): string[] {
  const source = raw && raw.trim() ? raw : "pm25,pm10,no2";
  const codes = source
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return Array.from(new Set(codes));
}

export function assertIsoDay(day: string, label: string): void {
  if (!ISO_DAY_RE.test(day)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || toIsoDay(parsed) !== day) {
    throw new Error(`${label} is not a valid UTC day`);
  }
}

export function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, offsetDays: number): string {
  assertIsoDay(day, "day");
  return toIsoDay(
    new Date(Date.parse(`${day}T00:00:00.000Z`) + offsetDays * DAY_MS),
  );
}

export function compareIsoDay(a: string, b: string): number {
  assertIsoDay(a, "a");
  assertIsoDay(b, "b");
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetweenInclusive(startDay: string, endDay: string): number {
  assertIsoDay(startDay, "startDay");
  assertIsoDay(endDay, "endDay");
  const delta = Date.parse(`${endDay}T00:00:00.000Z`) -
    Date.parse(`${startDay}T00:00:00.000Z`);
  return Math.trunc(delta / DAY_MS) + 1;
}

export function latestCompleteDayUtc(
  now: Date,
  maturityDelayHours: number,
): string {
  const maturityMs = Math.max(0, maturityDelayHours) * 60 * 60 * 1000;
  const matureInstant = new Date(now.getTime() - maturityMs);
  return addDays(toIsoDay(matureInstant), -1);
}

export function buildRunConfig(params: {
  runMode: RunMode;
  triggerMode: TriggerMode;
  now: Date;
  explicitStartDayUtc?: string | null;
  explicitEndDayUtc?: string | null;
  lookbackDays: number;
  maturityDelayHours: number;
  connectorId: number;
  sourceNetworkCode: string;
  pollutantCodes: string[];
  minValidHoursPerDay: number;
  minValidDays: number;
  minFinalHourCoverageRatio: number;
  readinessGateEnabled: boolean;
  summaryRefreshEnabled: boolean;
  r2PublishEnabled?: boolean;
  parquetExportEnabled?: boolean;
  chunkDays: number;
}): RunConfig {
  const latestComplete = latestCompleteDayUtc(
    params.now,
    params.maturityDelayHours,
  );
  const dryRun = params.runMode === "dry_run";
  let startDay = params.explicitStartDayUtc || "";
  let endDay = params.explicitEndDayUtc || "";

  if (params.runMode === "backfill") {
    if (!startDay || !endDay) {
      throw new Error("backfill requires start_day_utc and end_day_utc");
    }
  } else {
    endDay = endDay || latestComplete;
    const lookback = Math.max(1, Math.trunc(params.lookbackDays));
    startDay = startDay || addDays(endDay, -(lookback - 1));
  }

  assertIsoDay(startDay, "start_day_utc");
  assertIsoDay(endDay, "end_day_utc");
  if (compareIsoDay(endDay, startDay) < 0) {
    throw new Error("end_day_utc must be >= start_day_utc");
  }
  if (!Number.isInteger(params.connectorId) || params.connectorId <= 0) {
    throw new Error("connector_id must be a positive integer");
  }
  if (!params.pollutantCodes.length) {
    throw new Error("at least one pollutant code is required");
  }
  if (params.minValidHoursPerDay < 1 || params.minValidHoursPerDay > 24) {
    throw new Error("min_valid_hours_per_day must be between 1 and 24");
  }
  if (!Number.isFinite(params.minFinalHourCoverageRatio)) {
    throw new Error("min_final_hour_coverage_ratio must be finite");
  }

  return {
    runMode: params.runMode,
    triggerMode: params.triggerMode,
    startDayUtc: startDay,
    endDayUtc: endDay,
    latestCompleteDayUtc: latestComplete,
    connectorId: params.connectorId,
    sourceNetworkCode: params.sourceNetworkCode.trim().toLowerCase() ||
      "gov_uk_aurn",
    pollutantCodes: params.pollutantCodes,
    minValidHoursPerDay: Math.trunc(params.minValidHoursPerDay),
    minValidDays: Math.max(1, Math.trunc(params.minValidDays)),
    minFinalHourCoverageRatio: clampRatio(params.minFinalHourCoverageRatio),
    readinessGateEnabled: params.readinessGateEnabled,
    summaryRefreshEnabled: params.summaryRefreshEnabled,
    r2PublishEnabled: Boolean(params.r2PublishEnabled),
    parquetExportEnabled: Boolean(params.parquetExportEnabled),
    chunkDays: Math.max(1, Math.trunc(params.chunkDays)),
    dryRun,
  };
}

export function buildDayChunks(
  startDayUtc: string,
  endDayUtc: string,
  chunkDays: number,
): Array<{ startDayUtc: string; endDayUtc: string }> {
  assertIsoDay(startDayUtc, "startDayUtc");
  assertIsoDay(endDayUtc, "endDayUtc");
  const size = Math.max(1, Math.trunc(chunkDays));
  const chunks: Array<{ startDayUtc: string; endDayUtc: string }> = [];
  let cursor = startDayUtc;
  while (compareIsoDay(cursor, endDayUtc) <= 0) {
    const chunkEnd = minIsoDay(addDays(cursor, size - 1), endDayUtc);
    chunks.push({ startDayUtc: cursor, endDayUtc: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

export function buildReadinessPayload(
  config: RunConfig,
): ReadinessRpcPayload {
  return {
    p_as_of_day_utc: config.endDayUtc,
    p_connector_id: config.connectorId,
    p_source_network_code: config.sourceNetworkCode,
    p_pollutant_codes: config.pollutantCodes,
    p_min_final_hour_coverage_ratio: config.minFinalHourCoverageRatio,
  };
}

export function buildDailyRefreshPayload(
  config: RunConfig,
  chunk: { startDayUtc: string; endDayUtc: string },
): DailyRefreshRpcPayload {
  return {
    p_start_day_utc: chunk.startDayUtc,
    p_end_day_utc: chunk.endDayUtc,
    p_connector_id: config.connectorId,
    p_source_network_code: config.sourceNetworkCode,
    p_pollutant_codes: config.pollutantCodes,
    p_min_valid_hours_per_day: config.minValidHoursPerDay,
    p_dry_run: config.dryRun,
  };
}

export function buildSummaryRefreshPayload(
  config: RunConfig,
): SummaryRefreshRpcPayload {
  return {
    p_as_of_day_utc: config.endDayUtc,
    p_connector_id: config.connectorId,
    p_source_network_code: config.sourceNetworkCode,
    p_pollutant_codes: config.pollutantCodes,
    p_min_valid_days: config.minValidDays,
    p_min_valid_hours_per_day: config.minValidHoursPerDay,
    p_dry_run: config.dryRun,
  };
}

export function mergeDailyRefreshRows(
  rows: DailyRefreshRpcRow[],
): DailyRefreshSummary {
  const candidateCounts = rows.map((row) =>
    Number(row.candidate_timeseries_count) || 0
  );
  return {
    chunks: rows.length,
    candidate_timeseries_count: candidateCounts.length
      ? Math.max(...candidateCounts)
      : 0,
    candidate_timeseries_days: sumRows(rows, "candidate_timeseries_days"),
    source_hour_rows: sumRows(rows, "source_hour_rows"),
    valid_timeseries_days: sumRows(rows, "valid_timeseries_days"),
    not_enough_data_timeseries_days: sumRows(
      rows,
      "not_enough_data_timeseries_days",
    ),
    rows_upserted: sumRows(rows, "rows_upserted"),
  };
}

export function summarizeReadinessRows(
  rows: ReadinessRpcRow[],
  asOfDayUtc: string,
): ReadinessSummary {
  return {
    checked: true,
    ready: rows.length > 0 && rows.every((row) => row.pollutant_ready),
    already_completed: rows.some((row) => row.already_completed),
    as_of_day_utc: asOfDayUtc,
    final_hour_observed_at: rows[0]?.final_hour_observed_at || null,
    pollutant_rows: rows,
  };
}

export function shouldRunReadinessGate(config: RunConfig): boolean {
  return config.readinessGateEnabled &&
    config.runMode === "daily" &&
    !config.dryRun;
}

function minIsoDay(a: string, b: string): string {
  return compareIsoDay(a, b) <= 0 ? a : b;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.9;
  return Math.min(1, Math.max(0, value));
}

function sumRows(
  rows: DailyRefreshRpcRow[],
  key: keyof DailyRefreshRpcRow,
): number {
  return rows.reduce((total, row) => {
    const value = Number(row[key]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}


export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

export function buildR2PublishPlan(args: {
  asOfDayUtc: string;
  connectorId: number;
  pollutantCodes: string[];
  calendarYear: number | null | undefined;
}): R2PublishPlan {
  assertIsoDay(args.asOfDayUtc, "asOfDayUtc");
  const connector = `connector_id=${args.connectorId}`;
  const pollutant = "pollutant_code=<pollutant>";
  const calendarYear = Number(args.calendarYear) || Number(args.asOfDayUtc.slice(0, 4)) - 1;
  return {
    datedSummaryKey: `history/v2/who_2021/summaries/as_of_day_utc=${args.asOfDayUtc}/who_2021_summary.json`,
    latestSummaryKey: "history/v2/who_2021/latest_who_2021.json",
    dailyCacheQuery: `?as_of=${args.asOfDayUtc}`,
    parquetPrefixes: {
      dailyStatus: `history/v2/who_2021/daily_status/day_utc=<YYYY-MM-DD>/${connector}/${pollutant}/`,
      rollingYearStatus: `history/v2/who_2021/rolling_year_status/as_of_day_utc=${args.asOfDayUtc}/${connector}/${pollutant}/`,
      calendarYearStatus: `history/v2/who_2021/calendar_year_status/calendar_year=${calendarYear}/period_type=complete_year/${connector}/${pollutant}/`,
    },
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortJsonValue(record[key]);
    return out;
  }
  return value;
}
