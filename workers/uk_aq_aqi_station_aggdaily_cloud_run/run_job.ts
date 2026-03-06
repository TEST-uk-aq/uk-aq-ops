type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type RunMode = "fast" | "reconcile_short" | "reconcile_deep" | "backfill";

type SourceRow = {
  station_id: number;
  timestamp_hour_utc: string;
  pollutant_code: "pm25" | "pm10" | "no2";
  hourly_mean_ugm3: number;
  sample_count: number;
};

type BreakpointRow = {
  standard_code: "daqi" | "eaqi";
  pollutant_code: "pm25" | "pm10" | "no2";
  averaging_code: "hourly_mean" | "rolling_24h_mean";
  index_level: number;
  index_band: string;
  range_low: number;
  range_high: number | null;
};

type IndexMatch = {
  index_level: number;
  index_band: string;
};

type PollutantHour = {
  hourlyMean: number;
  sampleCount: number;
};

type HourlyUpsertMetrics = {
  rows_attempted: number;
  rows_changed: number;
  rows_inserted: number;
  rows_updated: number;
  station_hours_changed: number;
  station_hours_changed_gt_cutoff: number;
  max_changed_lag_hours: number | null;
};

type RollupMetrics = {
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
};

type CandidateHourlyRow = {
  station_id: number;
  timestamp_hour_utc: string;

  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;

  no2_hourly_sample_count: number | null;
  pm25_hourly_sample_count: number | null;
  pm10_hourly_sample_count: number | null;

  pm25_rolling24h_valid_hours: number | null;
  pm10_rolling24h_valid_hours: number | null;

  daqi_no2_index_level: number | null;
  daqi_no2_index_band: string | null;
  daqi_pm25_index_level: number | null;
  daqi_pm25_index_band: string | null;
  daqi_pm10_index_level: number | null;
  daqi_pm10_index_band: string | null;

  eaqi_no2_index_level: number | null;
  eaqi_no2_index_band: string | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm25_index_band: string | null;
  eaqi_pm10_index_level: number | null;
  eaqi_pm10_index_band: string | null;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

const INGEST_SUPABASE_URL = requiredEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const AGGDAILY_SUPABASE_URL = requiredEnv("AGGDAILY_SUPABASE_URL");
const AGGDAILY_PRIVILEGED_KEY = requiredEnv("AGGDAILY_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public").trim();
const SOURCE_RPC = (Deno.env.get("UK_AQ_AQI_SOURCE_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_source").trim();
const BREAKPOINTS_RPC = (Deno.env.get("UK_AQ_AQI_BREAKPOINTS_RPC") ||
  "uk_aq_rpc_aqi_breakpoints_active").trim();
const HOURLY_UPSERT_RPC = (Deno.env.get("UK_AQ_AQI_HOURLY_UPSERT_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC = (Deno.env.get("UK_AQ_AQI_ROLLUP_REFRESH_RPC") ||
  "uk_aq_rpc_station_aqi_rollups_refresh").trim();
const RUN_LOG_RPC = (Deno.env.get("UK_AQ_AQI_RUN_LOG_RPC") ||
  "uk_aq_rpc_aqi_compute_run_log").trim();
const RUN_CLEANUP_RPC = (Deno.env.get("UK_AQ_AQI_RUN_CLEANUP_RPC") ||
  "uk_aq_rpc_aqi_compute_runs_cleanup").trim();

const RUN_MODE = parseRunMode(Deno.env.get("UK_AQ_AQI_RUN_MODE"), "fast");
const TRIGGER_MODE = (Deno.env.get("UK_AQ_AQI_TRIGGER_MODE") || "manual").trim() || "manual";
const MATURITY_DELAY_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_MATURITY_DELAY_HOURS"),
  3,
);
const SHORT_LOOKBACK_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_SHORT_LOOKBACK_HOURS"),
  36,
);
const DEEP_LOOKBACK_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_DEEP_LOOKBACK_DAYS"),
  14,
);
const RPC_RETRIES = parsePositiveInt(Deno.env.get("UK_AQ_AQI_RPC_RETRIES"), 3);
const HOURLY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_HOURLY_UPSERT_CHUNK_SIZE"),
  2000,
);
const SOURCE_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_SOURCE_PAGE_SIZE"),
  1000,
);
const RUN_LOG_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RUN_LOG_RETENTION_DAYS"),
  7,
);
const FROM_HOUR_UTC = optionalEnv("UK_AQ_AQI_FROM_HOUR_UTC");
const TO_HOUR_UTC = optionalEnv("UK_AQ_AQI_TO_HOUR_UTC");
const STATION_IDS = parseStationIdsCsv(optionalEnv("UK_AQ_AQI_STATION_IDS_CSV"));

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredEnvAny(names: string[]): string {
  for (const name of names) {
    const value = (Deno.env.get(name) || "").trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: one of ${names.join(", ")}`);
}

function optionalEnv(name: string): string | null {
  const value = (Deno.env.get(name) || "").trim();
  return value || null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseRunMode(raw: string | undefined, fallback: RunMode): RunMode {
  const value = (raw || "").trim().toLowerCase();
  if (
    value === "fast" ||
    value === "reconcile_short" ||
    value === "reconcile_deep" ||
    value === "backfill"
  ) {
    return value;
  }
  return fallback;
}

function parseStationIdsCsv(raw: string | null): number[] | null {
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
    .map((value) => Math.trunc(value));
  if (!ids.length) {
    return null;
  }
  return Array.from(new Set(ids));
}

function normalizeUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}/rest/v1`;
}

function asErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error_description", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return `HTTP ${status}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postgrestRpc<T>(
  baseUrl: string,
  privilegedKey: string,
  rpcName: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const url = `${normalizeUrl(baseUrl)}/rpc/${rpcName}`;
  const headers: Record<string, string> = {
    apikey: privilegedKey,
    Authorization: `Bearer ${privilegedKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": RPC_SCHEMA,
    "Content-Profile": RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_aqi_station_aggdaily_cloud_run",
  };

  for (let attempt = 1; attempt <= RPC_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      });
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);

      if (response.ok) {
        return { data: payload as T, error: null };
      }

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

function floorUtcHour(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  ));
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * ONE_HOUR_MS);
}

function parseIsoHour(raw: string): Date {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${raw}`);
  }
  return floorUtcHour(new Date(ms));
}

function hourIso(date: Date): string {
  return floorUtcHour(date).toISOString();
}

function runWindow(nowUtc: Date): {
  start: Date;
  endExclusive: Date;
  sourceStart: Date;
  referenceHour: Date;
} {
  const matureHour = floorUtcHour(new Date(nowUtc.getTime() - MATURITY_DELAY_HOURS * ONE_HOUR_MS));

  if (RUN_MODE === "backfill") {
    if (!FROM_HOUR_UTC || !TO_HOUR_UTC) {
      throw new Error("Backfill mode requires UK_AQ_AQI_FROM_HOUR_UTC and UK_AQ_AQI_TO_HOUR_UTC");
    }
    const fromHour = parseIsoHour(FROM_HOUR_UTC);
    const toHourInclusive = parseIsoHour(TO_HOUR_UTC);
    if (toHourInclusive.getTime() < fromHour.getTime()) {
      throw new Error("UK_AQ_AQI_TO_HOUR_UTC must be >= UK_AQ_AQI_FROM_HOUR_UTC");
    }
    const endExclusive = addHours(toHourInclusive, 1);
    return {
      start: fromHour,
      endExclusive,
      sourceStart: addHours(fromHour, -23),
      referenceHour: matureHour,
    };
  }

  if (RUN_MODE === "fast") {
    const start = matureHour;
    const endExclusive = addHours(start, 1);
    return {
      start,
      endExclusive,
      sourceStart: addHours(start, -23),
      referenceHour: matureHour,
    };
  }

  if (RUN_MODE === "reconcile_short") {
    const start = addHours(matureHour, -(SHORT_LOOKBACK_HOURS - 1));
    const endExclusive = addHours(matureHour, 1);
    return {
      start,
      endExclusive,
      sourceStart: addHours(start, -23),
      referenceHour: matureHour,
    };
  }

  const deepHours = DEEP_LOOKBACK_DAYS * 24;
  const start = addHours(matureHour, -(deepHours - 1));
  const endExclusive = addHours(matureHour, 1);
  return {
    start,
    endExclusive,
    sourceStart: addHours(start, -23),
    referenceHour: matureHour,
  };
}

function parseSourceRows(payload: unknown): SourceRow[] {
  if (!Array.isArray(payload)) {
    throw new Error("source RPC returned non-array payload");
  }
  const rows: SourceRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const pollutant = String(row.pollutant_code || "").trim().toLowerCase();
    if (pollutant !== "pm25" && pollutant !== "pm10" && pollutant !== "no2") {
      continue;
    }
    const stationId = Number(row.station_id);
    const hourlyMean = Number(row.hourly_mean_ugm3);
    const sampleCount = Number(row.sample_count);
    const timestamp = String(row.timestamp_hour_utc || "").trim();
    if (!Number.isInteger(stationId) || stationId <= 0 || Number.isNaN(Date.parse(timestamp))) {
      continue;
    }
    if (!Number.isFinite(hourlyMean)) {
      continue;
    }
    rows.push({
      station_id: Math.trunc(stationId),
      timestamp_hour_utc: hourIso(new Date(Date.parse(timestamp))),
      pollutant_code: pollutant,
      hourly_mean_ugm3: hourlyMean,
      sample_count: Number.isFinite(sampleCount) ? Math.trunc(sampleCount) : 0,
    });
  }
  return rows;
}

function hasStatementTimeout(message: string): boolean {
  return message.toLowerCase().includes("statement timeout");
}

function hourDiff(start: Date, endExclusive: Date): number {
  const diffMs = endExclusive.getTime() - start.getTime();
  return Math.max(0, Math.round(diffMs / ONE_HOUR_MS));
}

function midpointHour(start: Date, endExclusive: Date): Date {
  const hours = hourDiff(start, endExclusive);
  const leftHours = Math.max(1, Math.floor(hours / 2));
  return addHours(start, leftHours);
}

async function fetchSourceRowsRecursive(
  startHour: Date,
  endHourExclusive: Date,
  depth: number,
): Promise<SourceRow[]> {
  const sourceArgs: Record<string, unknown> = {
    p_window_start: hourIso(startHour),
    p_window_end: hourIso(endHourExclusive),
  };
  if (STATION_IDS && STATION_IDS.length > 0) {
    sourceArgs.p_station_ids = STATION_IDS;
  }

  const sourceResult = await postgrestRpc<unknown>(
    INGEST_SUPABASE_URL,
    INGEST_PRIVILEGED_KEY,
    SOURCE_RPC,
    sourceArgs,
  );

  const windowHours = hourDiff(startHour, endHourExclusive);
  const canSplit = windowHours > 1 && depth < 20;

  if (sourceResult.error) {
    if (canSplit && hasStatementTimeout(sourceResult.error.message)) {
      const mid = midpointHour(startHour, endHourExclusive);
      const left = await fetchSourceRowsRecursive(startHour, mid, depth + 1);
      const right = await fetchSourceRowsRecursive(mid, endHourExclusive, depth + 1);
      return [...left, ...right];
    }
    throw new Error(`source RPC failed: ${sourceResult.error.message}`);
  }

  const rows = parseSourceRows(sourceResult.data);
  const reachedApiCap = rows.length >= SOURCE_PAGE_SIZE;
  if (reachedApiCap && canSplit) {
    const mid = midpointHour(startHour, endHourExclusive);
    const left = await fetchSourceRowsRecursive(startHour, mid, depth + 1);
    const right = await fetchSourceRowsRecursive(mid, endHourExclusive, depth + 1);
    return [...left, ...right];
  }

  if (reachedApiCap && !canSplit) {
    throw new Error(
      "source RPC result saturated API row cap for a 1-hour window; increase API max rows or run with station filter",
    );
  }

  return rows;
}

async function fetchSourceRows(sourceStart: Date, sourceEndExclusive: Date): Promise<SourceRow[]> {
  const rows = await fetchSourceRowsRecursive(sourceStart, sourceEndExclusive, 0);
  rows.sort((a, b) => {
    if (a.timestamp_hour_utc < b.timestamp_hour_utc) return -1;
    if (a.timestamp_hour_utc > b.timestamp_hour_utc) return 1;
    if (a.station_id !== b.station_id) return a.station_id - b.station_id;
    if (a.pollutant_code < b.pollutant_code) return -1;
    if (a.pollutant_code > b.pollutant_code) return 1;
    return 0;
  });
  return rows;
}

function parseBreakpoints(payload: unknown): BreakpointRow[] {
  if (!Array.isArray(payload)) {
    throw new Error("breakpoints RPC returned non-array payload");
  }
  const rows: BreakpointRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const standard = String(row.standard_code || "").trim().toLowerCase();
    const pollutant = String(row.pollutant_code || "").trim().toLowerCase();
    const averaging = String(row.averaging_code || "").trim().toLowerCase();
    if ((standard !== "daqi" && standard !== "eaqi") ||
      (pollutant !== "pm25" && pollutant !== "pm10" && pollutant !== "no2") ||
      (averaging !== "hourly_mean" && averaging !== "rolling_24h_mean")) {
      continue;
    }
    const indexLevel = Number(row.index_level);
    const rangeLow = Number(row.range_low);
    const rangeHighRaw = row.range_high;
    const rangeHigh = rangeHighRaw === null || rangeHighRaw === undefined
      ? null
      : Number(rangeHighRaw);
    const indexBand = String(row.index_band || "").trim();
    if (!Number.isFinite(indexLevel) || !Number.isFinite(rangeLow) || !indexBand) {
      continue;
    }
    rows.push({
      standard_code: standard,
      pollutant_code: pollutant,
      averaging_code: averaging,
      index_level: Math.trunc(indexLevel),
      index_band: indexBand,
      range_low: rangeLow,
      range_high: Number.isFinite(rangeHigh ?? Number.NaN) ? (rangeHigh as number) : null,
    });
  }
  rows.sort((a, b) => a.range_low - b.range_low || a.index_level - b.index_level);
  return rows;
}

function parseHourlyUpsertMetrics(payload: unknown): HourlyUpsertMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("hourly upsert RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    rows_attempted: toSafeInt(row.rows_attempted),
    rows_changed: toSafeInt(row.rows_changed),
    rows_inserted: toSafeInt(row.rows_inserted),
    rows_updated: toSafeInt(row.rows_updated),
    station_hours_changed: toSafeInt(row.station_hours_changed),
    station_hours_changed_gt_cutoff: toSafeInt(row.station_hours_changed_gt_cutoff),
    max_changed_lag_hours: toNullableNumber(row.max_changed_lag_hours),
  };
}

function parseRollupMetrics(payload: unknown): RollupMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("rollup refresh RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    daily_rows_upserted: toSafeInt(row.daily_rows_upserted),
    monthly_rows_upserted: toSafeInt(row.monthly_rows_upserted),
  };
}

function toSafeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function buildBreakpointMap(rows: BreakpointRow[]): Map<string, BreakpointRow[]> {
  const map = new Map<string, BreakpointRow[]>();
  for (const row of rows) {
    const key = `${row.standard_code}|${row.pollutant_code}|${row.averaging_code}`;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.range_low - b.range_low || a.index_level - b.index_level);
  }
  return map;
}

function lookupIndex(
  breakpointMap: Map<string, BreakpointRow[]>,
  standard: "daqi" | "eaqi",
  pollutant: "pm25" | "pm10" | "no2",
  averaging: "hourly_mean" | "rolling_24h_mean",
  value: number | null,
): IndexMatch | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const key = `${standard}|${pollutant}|${averaging}`;
  const rows = breakpointMap.get(key);
  if (!rows || !rows.length) {
    return null;
  }
  for (const row of rows) {
    if (value < row.range_low) {
      continue;
    }
    if (row.range_high === null || value <= row.range_high) {
      return {
        index_level: row.index_level,
        index_band: row.index_band,
      };
    }
  }
  return null;
}

function chunkRows<T>(rows: T[], chunkSize: number): T[][] {
  if (rows.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}

function mapKeyStationPollutant(stationId: number, pollutant: string): string {
  return `${stationId}|${pollutant}`;
}

function mapKeyStationHour(stationId: number, hourMs: number): string {
  return `${stationId}|${hourMs}`;
}

function parseStationHourKey(key: string): { stationId: number; hourMs: number } {
  const [stationRaw, hourRaw] = key.split("|");
  return {
    stationId: Number(stationRaw),
    hourMs: Number(hourRaw),
  };
}

function toHourMs(iso: string): number {
  return floorUtcHour(new Date(Date.parse(iso))).getTime();
}

function buildCandidateRows(
  sourceRows: SourceRow[],
  targetStart: Date,
  targetEndExclusive: Date,
  breakpointMap: Map<string, BreakpointRow[]>,
): CandidateHourlyRow[] {
  const hourlyByStationPollutant = new Map<string, Map<number, PollutantHour>>();
  const targetStationHourKeys = new Set<string>();

  const targetStartMs = targetStart.getTime();
  const targetEndMs = targetEndExclusive.getTime();

  for (const row of sourceRows) {
    const hourMs = toHourMs(row.timestamp_hour_utc);
    const stationPollutantKey = mapKeyStationPollutant(row.station_id, row.pollutant_code);
    const byHour = hourlyByStationPollutant.get(stationPollutantKey) || new Map<number, PollutantHour>();
    byHour.set(hourMs, {
      hourlyMean: row.hourly_mean_ugm3,
      sampleCount: row.sample_count,
    });
    hourlyByStationPollutant.set(stationPollutantKey, byHour);

    if (hourMs >= targetStartMs && hourMs < targetEndMs) {
      targetStationHourKeys.add(mapKeyStationHour(row.station_id, hourMs));
    }
  }

  function hourlyValue(
    stationId: number,
    pollutant: "pm25" | "pm10" | "no2",
    hourMs: number,
  ): PollutantHour | null {
    const byHour = hourlyByStationPollutant.get(mapKeyStationPollutant(stationId, pollutant));
    if (!byHour) {
      return null;
    }
    return byHour.get(hourMs) || null;
  }

  function rolling24h(
    stationId: number,
    pollutant: "pm25" | "pm10",
    endHourMs: number,
  ): { mean: number | null; validHours: number } {
    let sum = 0;
    let validHours = 0;
    for (let i = 0; i < 24; i += 1) {
      const hourValue = hourlyValue(stationId, pollutant, endHourMs - i * ONE_HOUR_MS);
      if (hourValue && Number.isFinite(hourValue.hourlyMean)) {
        sum += hourValue.hourlyMean;
        validHours += 1;
      }
    }
    if (validHours < 18) {
      return { mean: null, validHours };
    }
    return { mean: sum / validHours, validHours };
  }

  const rows: CandidateHourlyRow[] = [];

  for (const key of targetStationHourKeys) {
    const { stationId, hourMs } = parseStationHourKey(key);
    const no2 = hourlyValue(stationId, "no2", hourMs);
    const pm25 = hourlyValue(stationId, "pm25", hourMs);
    const pm10 = hourlyValue(stationId, "pm10", hourMs);

    const pm25Rolling = rolling24h(stationId, "pm25", hourMs);
    const pm10Rolling = rolling24h(stationId, "pm10", hourMs);

    const daqiNo2 = lookupIndex(
      breakpointMap,
      "daqi",
      "no2",
      "hourly_mean",
      no2?.hourlyMean ?? null,
    );
    const daqiPm25 = lookupIndex(
      breakpointMap,
      "daqi",
      "pm25",
      "rolling_24h_mean",
      pm25Rolling.mean,
    );
    const daqiPm10 = lookupIndex(
      breakpointMap,
      "daqi",
      "pm10",
      "rolling_24h_mean",
      pm10Rolling.mean,
    );

    const eaqiNo2 = lookupIndex(
      breakpointMap,
      "eaqi",
      "no2",
      "hourly_mean",
      no2?.hourlyMean ?? null,
    );
    const eaqiPm25 = lookupIndex(
      breakpointMap,
      "eaqi",
      "pm25",
      "hourly_mean",
      pm25?.hourlyMean ?? null,
    );
    const eaqiPm10 = lookupIndex(
      breakpointMap,
      "eaqi",
      "pm10",
      "hourly_mean",
      pm10?.hourlyMean ?? null,
    );

    const hasAnyValue =
      no2 !== null ||
      pm25 !== null ||
      pm10 !== null ||
      pm25Rolling.mean !== null ||
      pm10Rolling.mean !== null ||
      daqiNo2 !== null ||
      daqiPm25 !== null ||
      daqiPm10 !== null ||
      eaqiNo2 !== null ||
      eaqiPm25 !== null ||
      eaqiPm10 !== null;

    if (!hasAnyValue) {
      continue;
    }

    rows.push({
      station_id: stationId,
      timestamp_hour_utc: new Date(hourMs).toISOString(),

      no2_hourly_mean_ugm3: no2?.hourlyMean ?? null,
      pm25_hourly_mean_ugm3: pm25?.hourlyMean ?? null,
      pm10_hourly_mean_ugm3: pm10?.hourlyMean ?? null,
      pm25_rolling24h_mean_ugm3: pm25Rolling.mean,
      pm10_rolling24h_mean_ugm3: pm10Rolling.mean,

      no2_hourly_sample_count: no2?.sampleCount ?? null,
      pm25_hourly_sample_count: pm25?.sampleCount ?? null,
      pm10_hourly_sample_count: pm10?.sampleCount ?? null,

      pm25_rolling24h_valid_hours: pm25Rolling.validHours,
      pm10_rolling24h_valid_hours: pm10Rolling.validHours,

      daqi_no2_index_level: daqiNo2?.index_level ?? null,
      daqi_no2_index_band: daqiNo2?.index_band ?? null,
      daqi_pm25_index_level: daqiPm25?.index_level ?? null,
      daqi_pm25_index_band: daqiPm25?.index_band ?? null,
      daqi_pm10_index_level: daqiPm10?.index_level ?? null,
      daqi_pm10_index_band: daqiPm10?.index_band ?? null,

      eaqi_no2_index_level: eaqiNo2?.index_level ?? null,
      eaqi_no2_index_band: eaqiNo2?.index_band ?? null,
      eaqi_pm25_index_level: eaqiPm25?.index_level ?? null,
      eaqi_pm25_index_band: eaqiPm25?.index_band ?? null,
      eaqi_pm10_index_level: eaqiPm10?.index_level ?? null,
      eaqi_pm10_index_band: eaqiPm10?.index_band ?? null,
    });
  }

  rows.sort((a, b) => {
    if (a.timestamp_hour_utc < b.timestamp_hour_utc) return -1;
    if (a.timestamp_hour_utc > b.timestamp_hour_utc) return 1;
    return a.station_id - b.station_id;
  });

  return rows;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const nowUtc = new Date();
  const window = runWindow(nowUtc);
  const lateCutoffHour = addHours(window.referenceHour, -SHORT_LOOKBACK_HOURS);

  let sourceRowsCount = 0;
  let candidateStationHours = 0;
  let rowsUpserted = 0;
  let rowsChanged = 0;
  let stationHoursChanged = 0;
  let stationHoursChangedGt36h = 0;
  let maxChangedLagHours: number | null = null;
  let dailyRowsUpserted = 0;
  let monthlyRowsUpserted = 0;
  let runStatus: "ok" | "error" = "ok";
  let errorMessage: string | null = null;

  try {
    const sourceRows = await fetchSourceRows(window.sourceStart, window.endExclusive);
    sourceRowsCount = sourceRows.length;

    const breakpointsResult = await postgrestRpc<unknown>(
      AGGDAILY_SUPABASE_URL,
      AGGDAILY_PRIVILEGED_KEY,
      BREAKPOINTS_RPC,
      { p_effective_at: new Date().toISOString() },
    );
    if (breakpointsResult.error) {
      throw new Error(`breakpoints RPC failed: ${breakpointsResult.error.message}`);
    }
    const breakpoints = parseBreakpoints(breakpointsResult.data);
    const breakpointMap = buildBreakpointMap(breakpoints);

    const candidateRows = buildCandidateRows(
      sourceRows,
      window.start,
      window.endExclusive,
      breakpointMap,
    );
    candidateStationHours = candidateRows.length;

    if (candidateRows.length > 0) {
      const chunks = chunkRows(candidateRows, Math.max(100, HOURLY_UPSERT_CHUNK_SIZE));
      for (const chunk of chunks) {
        const upsertResult = await postgrestRpc<unknown>(
          AGGDAILY_SUPABASE_URL,
          AGGDAILY_PRIVILEGED_KEY,
          HOURLY_UPSERT_RPC,
          {
            p_rows: chunk,
            p_late_cutoff_hour: hourIso(lateCutoffHour),
            p_reference_hour: hourIso(window.referenceHour),
          },
        );
        if (upsertResult.error) {
          throw new Error(`hourly upsert RPC failed: ${upsertResult.error.message}`);
        }
        const metrics = parseHourlyUpsertMetrics(upsertResult.data);
        rowsUpserted += metrics.rows_changed;
        rowsChanged += metrics.rows_changed;
        stationHoursChanged += metrics.station_hours_changed;
        stationHoursChangedGt36h += metrics.station_hours_changed_gt_cutoff;
        if (metrics.max_changed_lag_hours !== null) {
          maxChangedLagHours = maxChangedLagHours === null
            ? metrics.max_changed_lag_hours
            : Math.max(maxChangedLagHours, metrics.max_changed_lag_hours);
        }
      }

      const stationIds = Array.from(new Set(candidateRows.map((row) => row.station_id)));
      const rollupResult = await postgrestRpc<unknown>(
        AGGDAILY_SUPABASE_URL,
        AGGDAILY_PRIVILEGED_KEY,
        ROLLUP_REFRESH_RPC,
        {
          p_start_hour_utc: hourIso(window.start),
          p_end_hour_utc: hourIso(window.endExclusive),
          p_station_ids: stationIds,
        },
      );
      if (rollupResult.error) {
        throw new Error(`rollup refresh RPC failed: ${rollupResult.error.message}`);
      }
      const rollupMetrics = parseRollupMetrics(rollupResult.data);
      dailyRowsUpserted = rollupMetrics.daily_rows_upserted;
      monthlyRowsUpserted = rollupMetrics.monthly_rows_upserted;
    }
  } catch (error) {
    runStatus = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const durationMs = Date.now() - startedAt;
  const deepReconcileEffective = RUN_MODE === "reconcile_deep"
    ? stationHoursChangedGt36h > 0
    : null;

  const runLogResult = await postgrestRpc<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    RUN_LOG_RPC,
    {
      p_run_mode: RUN_MODE,
      p_trigger_mode: TRIGGER_MODE,
      p_window_start_utc: hourIso(window.start),
      p_window_end_utc: hourIso(window.endExclusive),
      p_source_rows: sourceRowsCount,
      p_candidate_station_hours: candidateStationHours,
      p_rows_upserted: rowsUpserted,
      p_rows_changed: rowsChanged,
      p_station_hours_changed: stationHoursChanged,
      p_station_hours_changed_gt_36h: stationHoursChangedGt36h,
      p_max_changed_lag_hours: maxChangedLagHours,
      p_deep_reconcile_effective: deepReconcileEffective,
      p_daily_rows_upserted: dailyRowsUpserted,
      p_monthly_rows_upserted: monthlyRowsUpserted,
      p_run_status: runStatus,
      p_error_message: errorMessage,
      p_duration_ms: durationMs,
    },
  );
  if (runLogResult.error) {
    console.error(JSON.stringify({
      level: "error",
      event: "aqi_run_log_failed",
      message: runLogResult.error.message,
    }));
  }

  const cleanupResult = await postgrestRpc<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    RUN_CLEANUP_RPC,
    {
      p_retention_days: RUN_LOG_RETENTION_DAYS,
    },
  );
  if (cleanupResult.error) {
    console.error(JSON.stringify({
      level: "error",
      event: "aqi_run_log_cleanup_failed",
      message: cleanupResult.error.message,
    }));
  }

  const summary = {
    ok: runStatus === "ok",
    run_mode: RUN_MODE,
    trigger_mode: TRIGGER_MODE,
    window_start_utc: hourIso(window.start),
    window_end_utc: hourIso(window.endExclusive),
    source_rows: sourceRowsCount,
    candidate_station_hours: candidateStationHours,
    rows_upserted: rowsUpserted,
    rows_changed: rowsChanged,
    station_hours_changed: stationHoursChanged,
    station_hours_changed_gt_36h: stationHoursChangedGt36h,
    max_changed_lag_hours: maxChangedLagHours,
    daily_rows_upserted: dailyRowsUpserted,
    monthly_rows_upserted: monthlyRowsUpserted,
    duration_ms: durationMs,
    error: errorMessage,
  };

  if (runStatus === "ok") {
    console.log(JSON.stringify(summary));
    return;
  }

  console.error(JSON.stringify(summary));
  throw new Error(errorMessage || "aqi_run_failed");
}

if (import.meta.main) {
  await main();
}
