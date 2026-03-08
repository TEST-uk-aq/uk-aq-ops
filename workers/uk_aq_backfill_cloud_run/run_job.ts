import {
  addUtcHours,
  buildBackwardDayRange,
  compareIsoDay,
  computeRollingLocalRetentionWindow,
  dayRangeDaysCount,
  isDayInRollingRetentionWindow,
  isDayLikelyInIngestWindow,
  parseBooleanish,
  parseConnectorIds,
  parseIsoDayUtc,
  parsePositiveInt,
  parseRunMode,
  parseTriggerMode,
  shiftIsoDay,
  shouldSkipCompletedDay,
  utcDayEndIso,
  utcDayStartIso,
} from "./backfill_core.mjs";

type RunMode = "local_to_aggdaily" | "obs_aqi_to_r2" | "source_to_all";
type TriggerMode = "scheduler" | "manual";
type SourceKind = "ingestdb" | "obs_aqidb" | "r2";
type RunStatus = "ok" | "error" | "dry_run" | "stubbed";

type SourceDbConfig = {
  kind: "ingestdb" | "obs_aqidb";
  base_url: string;
  privileged_key: string;
};

type RpcError = { message: string };
type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
  status: number;
};

type TableResult<T> = {
  data: T | null;
  error: string | null;
  status: number;
};

type FingerprintRow = {
  connector_id: number;
  observation_count: number;
};

type SourceNarrowRow = {
  station_id: number;
  timestamp_hour_utc: string;
  pollutant_code: string;
  hourly_mean_ugm3: number | null;
  sample_count: number | null;
};

type HelperRow = {
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
};

type HourlyUpsertMetrics = {
  rows_changed: number;
  station_hours_changed: number;
};

type RollupMetrics = {
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
};

type LocalToAggDailyDayConnectorResult = {
  day_utc: string;
  connector_id: number;
  source_kind: SourceKind;
  status: "complete" | "skipped" | "error" | "dry_run";
  skip_reason: string | null;
  rows_read: number;
  rows_written_aggdaily: number;
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
  error: string | null;
};

type LocalToAggDailySummary = {
  mode: "local_to_aggdaily";
  run_id: string;
  dry_run: boolean;
  force_replace: boolean;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
  days_processed: number;
  connector_day_complete: number;
  connector_day_skipped: number;
  connector_day_error: number;
  rows_read: number;
  rows_written_aggdaily: number;
  rollup_daily_rows_upserted: number;
  rollup_monthly_rows_upserted: number;
  day_connector_results: LocalToAggDailyDayConnectorResult[];
};

type StubModeSummary = {
  mode: "obs_aqi_to_r2" | "source_to_all";
  run_id: string;
  stubbed: true;
  message: string;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
  retention_window?: Record<string, unknown>;
  observs_write_eligible_days?: string[];
  observs_write_skipped_days?: string[];
};

type RunSummary = LocalToAggDailySummary | StubModeSummary;

const INGEST_SUPABASE_URL = optionalEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = optionalEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = optionalEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQI_PRIVILEGED_KEY = optionalEnv("OBS_AQIDB_SECRET_KEY");
const AGGDAILY_SUPABASE_URL = optionalEnv("AGGDAILY_SUPABASE_URL");
const AGGDAILY_PRIVILEGED_KEY = optionalEnv("AGGDAILY_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public").trim();
const OPS_SCHEMA = (Deno.env.get("UK_AQ_BACKFILL_OPS_SCHEMA") || "uk_aq_ops").trim();

const HOURLY_FINGERPRINT_RPC = (Deno.env.get("UK_AQ_BACKFILL_HOURLY_FINGERPRINT_RPC") ||
  "uk_aq_rpc_observations_hourly_fingerprint").trim();
const SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_source").trim();
const HOURLY_UPSERT_RPC = (Deno.env.get("UK_AQ_BACKFILL_AGGDAILY_HOURLY_UPSERT_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC = (Deno.env.get("UK_AQ_BACKFILL_AGGDAILY_ROLLUP_REFRESH_RPC") ||
  "uk_aq_rpc_station_aqi_rollups_refresh").trim();

const RUN_MODE = parseRunMode(
  Deno.env.get("UK_AQ_BACKFILL_RUN_MODE"),
  "local_to_aggdaily",
) as RunMode;
const TRIGGER_MODE = parseTriggerMode(
  Deno.env.get("UK_AQ_BACKFILL_TRIGGER_MODE"),
  "manual",
) as TriggerMode;
const DRY_RUN = parseBooleanish(Deno.env.get("UK_AQ_BACKFILL_DRY_RUN"), false);
const FORCE_REPLACE = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_FORCE_REPLACE"),
  false,
);
const ENABLE_R2_FALLBACK = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_ENABLE_R2_FALLBACK"),
  false,
);
const CONNECTOR_IDS = parseConnectorIds(optionalEnv("UK_AQ_BACKFILL_CONNECTOR_IDS"));

const SOURCE_RPC_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_RPC_RETRIES"),
  3,
  1,
  10,
);
const SOURCE_RPC_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC_PAGE_SIZE"),
  1000,
  100,
  5000,
);
const SOURCE_RPC_MAX_PAGES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC_MAX_PAGES"),
  200,
  1,
  2000,
);
const HOURLY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_HOURLY_UPSERT_CHUNK_SIZE"),
  2000,
  100,
  10000,
);
const INGEST_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_INGEST_RETENTION_DAYS"),
  7,
  1,
  14,
);
const OBS_AQI_LOCAL_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OBS_AQI_LOCAL_RETENTION_DAYS"),
  31,
  1,
  120,
);
const LOCAL_TIMEZONE = (Deno.env.get("UK_AQ_BACKFILL_LOCAL_TIMEZONE") || "Europe/London")
  .trim();
const STATION_ID_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_STATION_ID_PAGE_SIZE"),
  1000,
  100,
  10000,
);

const LEDGER_ENABLED = parseBooleanish(Deno.env.get("UK_AQ_BACKFILL_LEDGER_ENABLED"), true);
const DRY_RUN_WRITE_LEDGER = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_DRY_RUN_WRITE_LEDGER"),
  false,
);

const SOURCE_METADATA_SCHEMA = (Deno.env.get("UK_AQ_BACKFILL_METADATA_SCHEMA") || "uk_aq_core").trim();

function nowIso(): string {
  return new Date().toISOString();
}

function logStructured(level: "info" | "warning" | "error", event: string, details: Record<string, unknown>) {
  const entry = {
    level,
    event,
    timestamp: nowIso(),
    run_mode: RUN_MODE,
    trigger_mode: TRIGGER_MODE,
    ...details,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warning") {
    console.warn(line);
    return;
  }
  console.log(line);
}

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

function optionalEnvAny(names: string[]): string | null {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeRestUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}/rest/v1`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function asErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error_description", "error", "hint"]) {
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

function buildSourceDb(kind: "ingestdb" | "obs_aqidb"): SourceDbConfig | null {
  if (kind === "ingestdb") {
    if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
      return null;
    }
    return {
      kind,
      base_url: INGEST_SUPABASE_URL,
      privileged_key: INGEST_PRIVILEGED_KEY,
    };
  }

  if (!(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return null;
  }
  return {
    kind,
    base_url: OBS_AQIDB_SUPABASE_URL,
    privileged_key: OBS_AQI_PRIVILEGED_KEY,
  };
}

const SOURCE_DB_BY_KIND: Record<"ingestdb" | "obs_aqidb", SourceDbConfig | null> = {
  ingestdb: buildSourceDb("ingestdb"),
  obs_aqidb: buildSourceDb("obs_aqidb"),
};

const stationIdCache = new Map<number, number[]>();

async function postgrestRpc<T>(
  source: SourceDbConfig,
  rpcName: string,
  args: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<RpcResult<T>> {
  const queryString = query ? `?${query.toString()}` : "";
  const url = `${normalizeRestUrl(source.base_url)}/rpc/${rpcName}${queryString}`;
  const headers: Record<string, string> = {
    apikey: source.privileged_key,
    Authorization: `Bearer ${source.privileged_key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": RPC_SCHEMA,
    "Content-Profile": RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_backfill_cloud_run",
  };

  for (let attempt = 1; attempt <= SOURCE_RPC_RETRIES; attempt += 1) {
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
        return { data: payload as T, error: null, status: response.status };
      }

      if (attempt < SOURCE_RPC_RETRIES && isRetryableStatus(response.status)) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }

      return {
        data: null,
        error: { message: asErrorMessage(payload, response.status) },
        status: response.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < SOURCE_RPC_RETRIES) {
        await sleep(Math.min(5000, 1000 * attempt));
        continue;
      }
      return {
        data: null,
        error: { message },
        status: 0,
      };
    }
  }

  return { data: null, error: { message: "unknown_rpc_error" }, status: 0 };
}

async function postgrestTable<T>(
  baseUrl: string,
  privilegedKey: string,
  options: {
    method: "GET" | "POST" | "PATCH";
    schema: string;
    table: string;
    query?: URLSearchParams;
    body?: unknown;
    prefer?: string;
    rangeStart?: number;
    rangeEnd?: number;
  },
): Promise<TableResult<T>> {
  const queryString = options.query ? `?${options.query.toString()}` : "";
  const url = `${normalizeRestUrl(baseUrl)}/${options.table}${queryString}`;

  const headers: Record<string, string> = {
    apikey: privilegedKey,
    Authorization: `Bearer ${privilegedKey}`,
    Accept: "application/json",
    "Accept-Profile": options.schema,
    "x-ukaq-egress-caller": "uk_aq_backfill_cloud_run",
  };

  if (options.method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Content-Profile"] = options.schema;
  }
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }
  if (
    options.method === "GET" &&
    options.rangeStart !== undefined &&
    options.rangeEnd !== undefined
  ) {
    headers.Range = `${options.rangeStart}-${options.rangeEnd}`;
  }

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (response.ok) {
      return {
        data: payload as T,
        error: null,
        status: response.status,
      };
    }

    return {
      data: null,
      error: asErrorMessage(payload, response.status),
      status: response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      data: null,
      error: message,
      status: 0,
    };
  }
}

function toSafeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
}

function toSafeNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseIsoHour(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const date = new Date(parsed);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function parsePollutantCode(raw: unknown): "no2" | "pm25" | "pm10" | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "no2") {
    return "no2";
  }
  if (value === "pm25" || value === "pm2.5" || value === "pm2_5") {
    return "pm25";
  }
  if (value === "pm10") {
    return "pm10";
  }
  return null;
}

function parseSourceRows(payload: unknown): { narrowRows: SourceNarrowRow[]; helperRows: HelperRow[] } {
  if (!Array.isArray(payload)) {
    throw new Error("source RPC returned non-array payload");
  }

  const narrowRows: SourceNarrowRow[] = [];
  const helperRows: HelperRow[] = [];

  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const stationId = Number(row.station_id);
    const timestampHour = parseIsoHour(row.timestamp_hour_utc);
    if (!Number.isInteger(stationId) || stationId <= 0 || !timestampHour) {
      continue;
    }

    const pollutantCode = parsePollutantCode(row.pollutant_code);
    if (pollutantCode) {
      narrowRows.push({
        station_id: Math.trunc(stationId),
        timestamp_hour_utc: timestampHour,
        pollutant_code: pollutantCode,
        hourly_mean_ugm3: toSafeNumber(row.hourly_mean_ugm3),
        sample_count: toSafeNumber(row.sample_count),
      });
      continue;
    }

    helperRows.push({
      station_id: Math.trunc(stationId),
      timestamp_hour_utc: timestampHour,
      no2_hourly_mean_ugm3: toSafeNumber(row.no2_hourly_mean_ugm3),
      pm25_hourly_mean_ugm3: toSafeNumber(row.pm25_hourly_mean_ugm3),
      pm10_hourly_mean_ugm3: toSafeNumber(row.pm10_hourly_mean_ugm3),
      pm25_rolling24h_mean_ugm3: toSafeNumber(row.pm25_rolling24h_mean_ugm3),
      pm10_rolling24h_mean_ugm3: toSafeNumber(row.pm10_rolling24h_mean_ugm3),
      no2_hourly_sample_count: toSafeNumber(row.no2_hourly_sample_count),
      pm25_hourly_sample_count: toSafeNumber(row.pm25_hourly_sample_count),
      pm10_hourly_sample_count: toSafeNumber(row.pm10_hourly_sample_count),
    });
  }

  narrowRows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    if (left.station_id !== right.station_id) return left.station_id - right.station_id;
    return left.pollutant_code.localeCompare(right.pollutant_code);
  });

  helperRows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return left.station_id - right.station_id;
  });

  return { narrowRows, helperRows };
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function computeRolling24h(rowSet: HelperRow[]): void {
  const byStation = new Map<number, HelperRow[]>();
  for (const row of rowSet) {
    const list = byStation.get(row.station_id) || [];
    list.push(row);
    byStation.set(row.station_id, list);
  }

  for (const rows of byStation.values()) {
    rows.sort((left, right) => {
      if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
      if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
      return 0;
    });

    for (let i = 0; i < rows.length; i += 1) {
      const currentTs = Date.parse(rows[i].timestamp_hour_utc);

      const pm25Values: number[] = [];
      const pm10Values: number[] = [];

      for (let j = i; j >= 0; j -= 1) {
        const previousTs = Date.parse(rows[j].timestamp_hour_utc);
        const diffHours = Math.trunc((currentTs - previousTs) / (60 * 60 * 1000));
        if (diffHours > 23) {
          break;
        }
        const pm25 = rows[j].pm25_hourly_mean_ugm3;
        if (typeof pm25 === "number") {
          pm25Values.push(pm25);
        }
        const pm10 = rows[j].pm10_hourly_mean_ugm3;
        if (typeof pm10 === "number") {
          pm10Values.push(pm10);
        }
      }

      rows[i].pm25_rolling24h_mean_ugm3 = average(pm25Values);
      rows[i].pm10_rolling24h_mean_ugm3 = average(pm10Values);
    }
  }
}

function pivotNarrowRowsToHelperRows(narrowRows: SourceNarrowRow[]): HelperRow[] {
  const byKey = new Map<string, HelperRow>();
  for (const row of narrowRows) {
    const key = `${row.station_id}|${row.timestamp_hour_utc}`;
    const existing = byKey.get(key) || {
      station_id: row.station_id,
      timestamp_hour_utc: row.timestamp_hour_utc,
      no2_hourly_mean_ugm3: null,
      pm25_hourly_mean_ugm3: null,
      pm10_hourly_mean_ugm3: null,
      pm25_rolling24h_mean_ugm3: null,
      pm10_rolling24h_mean_ugm3: null,
      no2_hourly_sample_count: null,
      pm25_hourly_sample_count: null,
      pm10_hourly_sample_count: null,
    };

    if (row.pollutant_code === "no2") {
      existing.no2_hourly_mean_ugm3 = row.hourly_mean_ugm3;
      existing.no2_hourly_sample_count = row.sample_count === null ? null : Math.trunc(row.sample_count);
    } else if (row.pollutant_code === "pm25") {
      existing.pm25_hourly_mean_ugm3 = row.hourly_mean_ugm3;
      existing.pm25_hourly_sample_count = row.sample_count === null ? null : Math.trunc(row.sample_count);
    } else if (row.pollutant_code === "pm10") {
      existing.pm10_hourly_mean_ugm3 = row.hourly_mean_ugm3;
      existing.pm10_hourly_sample_count = row.sample_count === null ? null : Math.trunc(row.sample_count);
    }

    byKey.set(key, existing);
  }

  const rows = Array.from(byKey.values());
  rows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return left.station_id - right.station_id;
  });

  computeRolling24h(rows);
  return rows;
}

function narrowToDayRange(helperRows: HelperRow[], dayUtc: string): HelperRow[] {
  const dayStart = utcDayStartIso(dayUtc);
  const dayEnd = utcDayEndIso(dayUtc);

  return helperRows
    .filter((row) => row.timestamp_hour_utc >= dayStart && row.timestamp_hour_utc < dayEnd)
    .sort((left, right) => {
      if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
      if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
      return left.station_id - right.station_id;
    });
}

function parseHourlyUpsertMetrics(payload: unknown): HourlyUpsertMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("hourly upsert RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    rows_changed: toSafeInt(row.rows_changed),
    station_hours_changed: toSafeInt(row.station_hours_changed),
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

async function fetchStationIdsForConnector(connectorId: number): Promise<number[]> {
  const cached = stationIdCache.get(connectorId);
  if (cached) {
    return cached;
  }

  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    return [];
  }

  let start = 0;
  const stationIds = new Set<number>();

  while (true) {
    const query = new URLSearchParams();
    query.set("select", "station_id");
    query.set("connector_id", `eq.${connectorId}`);
    query.set("station_id", "not.is.null");
    query.set("order", "station_id.asc");

    const result = await postgrestTable<Array<Record<string, unknown>>>(
      INGEST_SUPABASE_URL,
      INGEST_PRIVILEGED_KEY,
      {
        method: "GET",
        schema: SOURCE_METADATA_SCHEMA,
        table: "timeseries",
        query,
        rangeStart: start,
        rangeEnd: start + STATION_ID_PAGE_SIZE - 1,
      },
    );

    if (result.error) {
      logStructured("warning", "backfill_station_ids_query_failed", {
        connector_id: connectorId,
        error: result.error,
      });
      break;
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    for (const row of rows) {
      const stationId = Number((row as Record<string, unknown>).station_id);
      if (Number.isInteger(stationId) && stationId > 0) {
        stationIds.add(Math.trunc(stationId));
      }
    }

    if (rows.length < STATION_ID_PAGE_SIZE) {
      break;
    }
    start += STATION_ID_PAGE_SIZE;
  }

  const sorted = Array.from(stationIds).sort((left, right) => left - right);
  stationIdCache.set(connectorId, sorted);
  return sorted;
}

async function fetchConnectorCountsForDay(
  sourceKind: "ingestdb" | "obs_aqidb",
  dayStartIso: string,
  dayEndIso: string,
): Promise<Map<number, number>> {
  const source = SOURCE_DB_BY_KIND[sourceKind];
  if (!source) {
    return new Map<number, number>();
  }

  const result = await postgrestRpc<unknown>(source, HOURLY_FINGERPRINT_RPC, {
    window_start: dayStartIso,
    window_end: dayEndIso,
  });

  if (result.error) {
    logStructured("warning", "backfill_fingerprint_query_failed", {
      source_kind: sourceKind,
      day_start_utc: dayStartIso,
      day_end_utc: dayEndIso,
      error: result.error.message,
    });
    return new Map<number, number>();
  }

  const rows = Array.isArray(result.data) ? result.data : [];
  const counts = new Map<number, number>();

  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const connectorId = Number(row.connector_id);
    if (!Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    const countValue = Number(row.observation_count);
    const count = Number.isFinite(countValue) ? Math.max(0, Math.trunc(countValue)) : 0;
    const current = counts.get(Math.trunc(connectorId)) || 0;
    counts.set(Math.trunc(connectorId), current + count);
  }

  return counts;
}

function connectorListFromCounts(
  ingestCounts: Map<number, number>,
  observsCounts: Map<number, number>,
): number[] {
  const connectorIds = new Set<number>();
  for (const key of ingestCounts.keys()) {
    connectorIds.add(key);
  }
  for (const key of observsCounts.keys()) {
    connectorIds.add(key);
  }
  return Array.from(connectorIds).sort((left, right) => left - right);
}

function chooseSourceForConnector(
  dayUtc: string,
  connectorId: number,
  ingestCounts: Map<number, number>,
  observsCounts: Map<number, number>,
): SourceKind | null {
  const prefersIngest = isDayLikelyInIngestWindow({
    dayUtc,
    nowUtc: new Date(),
    ingestRetentionDays: INGEST_RETENTION_DAYS,
  });

  const orderedSources: Array<"ingestdb" | "obs_aqidb"> = prefersIngest
    ? ["ingestdb", "obs_aqidb"]
    : ["obs_aqidb", "ingestdb"];

  for (const sourceKind of orderedSources) {
    const counts = sourceKind === "ingestdb" ? ingestCounts : observsCounts;
    const sourceConfig = SOURCE_DB_BY_KIND[sourceKind];
    if (!sourceConfig) {
      continue;
    }
    if ((counts.get(connectorId) || 0) > 0) {
      return sourceKind;
    }
  }

  if (ENABLE_R2_FALLBACK) {
    return "r2";
  }

  return null;
}

async function fetchSourceRowsForConnector(
  sourceKind: "ingestdb" | "obs_aqidb",
  connectorId: number,
  lookbackStartIso: string,
  dayEndIso: string,
): Promise<{ rows: unknown[]; source_filter: string }> {
  const source = SOURCE_DB_BY_KIND[sourceKind];
  if (!source) {
    throw new Error(`Source ${sourceKind} is not configured`);
  }

  const attempts: Array<{ args: Record<string, unknown>; label: string }> = [
    {
      args: {
        p_window_start: lookbackStartIso,
        p_window_end: dayEndIso,
        p_connector_ids: [connectorId],
      },
      label: "connector_ids_array",
    },
    {
      args: {
        p_window_start: lookbackStartIso,
        p_window_end: dayEndIso,
        p_connector_id: connectorId,
      },
      label: "connector_id_scalar",
    },
  ];

  const stationIds = await fetchStationIdsForConnector(connectorId);
  if (stationIds.length > 0) {
    attempts.push({
      args: {
        p_window_start: lookbackStartIso,
        p_window_end: dayEndIso,
        p_station_ids: stationIds,
      },
      label: "station_ids",
    });
  }

  let lastError = "unknown_source_rpc_error";
  let emptySuccessLabel: string | null = null;
  for (const attempt of attempts) {
    const rows: unknown[] = [];
    let attemptFailed = false;
    let hitMaxPages = true;

    for (let pageIndex = 0; pageIndex < SOURCE_RPC_MAX_PAGES; pageIndex += 1) {
      const query = new URLSearchParams();
      query.set("order", "timestamp_hour_utc.asc,station_id.asc,pollutant_code.asc");
      query.set("limit", String(SOURCE_RPC_PAGE_SIZE));
      query.set("offset", String(pageIndex * SOURCE_RPC_PAGE_SIZE));

      const response = await postgrestRpc<unknown>(source, SOURCE_RPC, attempt.args, query);
      if (response.error) {
        lastError = response.error.message;
        attemptFailed = true;
        hitMaxPages = false;
        break;
      }

      const pageRows = Array.isArray(response.data) ? response.data : [];
      rows.push(...pageRows);

      if (pageRows.length < SOURCE_RPC_PAGE_SIZE) {
        hitMaxPages = false;
        break;
      }
    }

    if (attemptFailed) {
      continue;
    }

    if (hitMaxPages) {
      logStructured("warning", "source_rpc_rows_truncated", {
        source_kind: sourceKind,
        connector_id: connectorId,
        source_filter: attempt.label,
        source_rpc_page_size: SOURCE_RPC_PAGE_SIZE,
        source_rpc_max_pages: SOURCE_RPC_MAX_PAGES,
        rows_fetched: rows.length,
      });
    }

    if (rows.length > 0) {
      return { rows, source_filter: attempt.label };
    }

    emptySuccessLabel = attempt.label;
  }

  if (emptySuccessLabel) {
    return { rows: [], source_filter: emptySuccessLabel };
  }

  throw new Error(
    `source RPC failed for ${sourceKind} connector=${connectorId}: ${lastError}`,
  );
}

async function upsertAggDailyRows(
  helperRows: HelperRow[],
  dayStartIso: string,
  dayEndIso: string,
): Promise<{ rowsWritten: number; dailyRows: number; monthlyRows: number }> {
  const aggdailyUrl = requiredEnv("AGGDAILY_SUPABASE_URL");
  const aggdailyKey = requiredEnv("AGGDAILY_SECRET_KEY");

  if (helperRows.length === 0) {
    return { rowsWritten: 0, dailyRows: 0, monthlyRows: 0 };
  }

  const aggdailySource: SourceDbConfig = {
    kind: "ingestdb",
    base_url: aggdailyUrl,
    privileged_key: aggdailyKey,
  };

  let rowsWritten = 0;
  let stationHoursChanged = 0;

  const referenceHour = addUtcHours(dayEndIso, -1);
  const lateCutoffHour = addUtcHours(referenceHour, -36);

  for (const chunk of chunkRows(helperRows, HOURLY_UPSERT_CHUNK_SIZE)) {
    const result = await postgrestRpc<unknown>(aggdailySource, HOURLY_UPSERT_RPC, {
      p_rows: chunk,
      p_late_cutoff_hour: lateCutoffHour,
      p_reference_hour: referenceHour,
    });
    if (result.error) {
      throw new Error(`AggDaily hourly upsert RPC failed: ${result.error.message}`);
    }

    const metrics = parseHourlyUpsertMetrics(result.data);
    rowsWritten += metrics.rows_changed;
    stationHoursChanged += metrics.station_hours_changed;
  }

  const stationIds = Array.from(new Set(helperRows.map((row) => row.station_id))).sort((l, r) => l - r);
  const rollupResult = await postgrestRpc<unknown>(aggdailySource, ROLLUP_REFRESH_RPC, {
    p_start_hour_utc: dayStartIso,
    p_end_hour_utc: dayEndIso,
    p_station_ids: stationIds,
  });
  if (rollupResult.error) {
    throw new Error(`AggDaily rollup refresh RPC failed: ${rollupResult.error.message}`);
  }

  const rollupMetrics = parseRollupMetrics(rollupResult.data);

  logStructured("info", "local_to_aggdaily_chunk_summary", {
    rows_written_aggdaily: rowsWritten,
    station_hours_changed: stationHoursChanged,
    daily_rows_upserted: rollupMetrics.daily_rows_upserted,
    monthly_rows_upserted: rollupMetrics.monthly_rows_upserted,
  });

  return {
    rowsWritten,
    dailyRows: rollupMetrics.daily_rows_upserted,
    monthlyRows: rollupMetrics.monthly_rows_upserted,
  };
}

function buildDefaultWindow(): { from_day_utc: string; to_day_utc: string } {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const yesterdayUtc = shiftIsoDay(todayUtc, -1);
  return {
    from_day_utc: yesterdayUtc,
    to_day_utc: yesterdayUtc,
  };
}

function resolveRunWindow(): { from_day_utc: string; to_day_utc: string } {
  const defaults = buildDefaultWindow();
  const fromDay = parseIsoDayUtc(optionalEnv("UK_AQ_BACKFILL_FROM_DAY_UTC")) || defaults.from_day_utc;
  const toDay = parseIsoDayUtc(optionalEnv("UK_AQ_BACKFILL_TO_DAY_UTC")) || fromDay;

  if (compareIsoDay(toDay, fromDay) < 0) {
    throw new Error("UK_AQ_BACKFILL_TO_DAY_UTC must be >= UK_AQ_BACKFILL_FROM_DAY_UTC");
  }

  return {
    from_day_utc: fromDay,
    to_day_utc: toDay,
  };
}

async function detectLedgerEnabled(): Promise<boolean> {
  if (!LEDGER_ENABLED) {
    return false;
  }
  if (!(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return false;
  }
  if (DRY_RUN && !DRY_RUN_WRITE_LEDGER) {
    return false;
  }

  const query = new URLSearchParams();
  query.set("select", "run_id");
  query.set("limit", "1");

  const result = await postgrestTable<unknown[]>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "GET",
      schema: OPS_SCHEMA,
      table: "backfill_runs",
      query,
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_disabled", {
      reason: result.error,
      status: result.status,
      schema: OPS_SCHEMA,
    });
    return false;
  }

  return true;
}

async function ledgerInsertRun(
  ledgerEnabled: boolean,
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
): Promise<void> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return;
  }

  const payload = {
    run_id: runId,
    run_mode: RUN_MODE,
    trigger_mode: TRIGGER_MODE,
    window_from_utc: window.from_day_utc,
    window_to_utc: window.to_day_utc,
    connector_filter: CONNECTOR_IDS,
    status: "in_progress",
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    started_at: nowIso(),
  };

  const result = await postgrestTable<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "POST",
      schema: OPS_SCHEMA,
      table: "backfill_runs",
      body: payload,
      prefer: "return=minimal",
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_insert_run_failed", {
      run_id: runId,
      error: result.error,
    });
  }
}

async function ledgerUpdateRun(
  ledgerEnabled: boolean,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return;
  }

  const query = new URLSearchParams();
  query.set("run_id", `eq.${runId}`);

  const result = await postgrestTable<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "PATCH",
      schema: OPS_SCHEMA,
      table: "backfill_runs",
      query,
      body: patch,
      prefer: "return=minimal",
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_update_run_failed", {
      run_id: runId,
      error: result.error,
    });
  }
}

async function ledgerFetchCheckpointStatus(
  ledgerEnabled: boolean,
  dayUtc: string,
  connectorId: number,
): Promise<string | null> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return null;
  }

  const query = new URLSearchParams();
  query.set("select", "status");
  query.set("run_mode", `eq.${RUN_MODE}`);
  query.set("day_utc", `eq.${dayUtc}`);
  query.set("connector_id", `eq.${connectorId}`);
  query.set("limit", "1");

  const result = await postgrestTable<Array<Record<string, unknown>>>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "GET",
      schema: OPS_SCHEMA,
      table: "backfill_checkpoints",
      query,
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_fetch_checkpoint_failed", {
      day_utc: dayUtc,
      connector_id: connectorId,
      error: result.error,
    });
    return null;
  }

  const rows = Array.isArray(result.data) ? result.data : [];
  if (rows.length === 0) {
    return null;
  }

  const status = rows[0]?.status;
  return typeof status === "string" ? status : null;
}

async function ledgerUpsertCheckpoint(
  ledgerEnabled: boolean,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "POST",
      schema: OPS_SCHEMA,
      table: "backfill_checkpoints",
      body: payload,
      prefer: "resolution=merge-duplicates,return=minimal",
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_checkpoint_upsert_failed", {
      error: result.error,
      payload,
    });
  }
}

async function ledgerInsertRunDay(
  ledgerEnabled: boolean,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "POST",
      schema: OPS_SCHEMA,
      table: "backfill_run_days",
      body: payload,
      prefer: "return=minimal",
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_insert_run_day_failed", {
      error: result.error,
      payload,
    });
  }
}

async function ledgerInsertError(
  ledgerEnabled: boolean,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!ledgerEnabled || !(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    AGGDAILY_SUPABASE_URL,
    AGGDAILY_PRIVILEGED_KEY,
    {
      method: "POST",
      schema: OPS_SCHEMA,
      table: "backfill_errors",
      body: payload,
      prefer: "return=minimal",
    },
  );

  if (result.error) {
    logStructured("warning", "backfill_ledger_insert_error_failed", {
      error: result.error,
      payload,
    });
  }
}

function normalizeRowsForDay(
  sourceRows: unknown[],
  dayUtc: string,
): { rowsRead: number; helperRows: HelperRow[] } {
  const parsed = parseSourceRows(sourceRows);

  if (parsed.helperRows.length > 0) {
    return {
      rowsRead: parsed.helperRows.length,
      helperRows: narrowToDayRange(parsed.helperRows, dayUtc),
    };
  }

  const helperRows = pivotNarrowRowsToHelperRows(parsed.narrowRows);
  return {
    rowsRead: parsed.narrowRows.length,
    helperRows: narrowToDayRange(helperRows, dayUtc),
  };
}

async function runLocalToAggDaily(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
): Promise<LocalToAggDailySummary> {
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    throw new Error("local_to_aggdaily requires SUPABASE_URL + SB_SECRET_KEY");
  }
  if (!(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    throw new Error("local_to_aggdaily requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }
  if (!(AGGDAILY_SUPABASE_URL && AGGDAILY_PRIVILEGED_KEY)) {
    throw new Error("local_to_aggdaily requires AGGDAILY_SUPABASE_URL + AGGDAILY_SECRET_KEY");
  }

  const days = buildBackwardDayRange(window.from_day_utc, window.to_day_utc);
  const summary: LocalToAggDailySummary = {
    mode: "local_to_aggdaily",
    run_id: runId,
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: days.length,
    days_processed: 0,
    connector_day_complete: 0,
    connector_day_skipped: 0,
    connector_day_error: 0,
    rows_read: 0,
    rows_written_aggdaily: 0,
    rollup_daily_rows_upserted: 0,
    rollup_monthly_rows_upserted: 0,
    day_connector_results: [],
  };

  for (const dayUtc of days) {
    const dayStartIso = utcDayStartIso(dayUtc);
    const dayEndIso = utcDayEndIso(dayUtc);

    logStructured("info", "local_to_aggdaily_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: CONNECTOR_IDS,
      ingest_retention_days: INGEST_RETENTION_DAYS,
    });

    const ingestCounts = await fetchConnectorCountsForDay("ingestdb", dayStartIso, dayEndIso);
    const observsCounts = await fetchConnectorCountsForDay("obs_aqidb", dayStartIso, dayEndIso);

    const connectors = CONNECTOR_IDS || connectorListFromCounts(ingestCounts, observsCounts);

    if (!connectors.length) {
      logStructured("warning", "local_to_aggdaily_day_no_connectors", {
        run_id: runId,
        day_utc: dayUtc,
      });
      continue;
    }

    for (const connectorId of connectors) {
      const sourceKind = chooseSourceForConnector(
        dayUtc,
        connectorId,
        ingestCounts,
        observsCounts,
      );

      if (!sourceKind) {
        const noSourceResult: LocalToAggDailyDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "skipped",
          skip_reason: "no_source_rows",
          rows_read: 0,
          rows_written_aggdaily: 0,
          daily_rows_upserted: 0,
          monthly_rows_upserted: 0,
          error: null,
        };
        summary.connector_day_skipped += 1;
        summary.day_connector_results.push(noSourceResult);
        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "none",
          status: "skipped",
          rows_read: 0,
          rows_written_aggdaily: 0,
          objects_written_r2: 0,
          checkpoint_json: { skip_reason: "no_source_rows" },
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        continue;
      }

      const existingStatus = await ledgerFetchCheckpointStatus(ledgerEnabled, dayUtc, connectorId);
      const skipDecision = shouldSkipCompletedDay(existingStatus, FORCE_REPLACE);

      if (skipDecision.skip) {
        const skippedResult: LocalToAggDailyDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "skipped",
          skip_reason: skipDecision.reason,
          rows_read: 0,
          rows_written_aggdaily: 0,
          daily_rows_upserted: 0,
          monthly_rows_upserted: 0,
          error: null,
        };
        summary.connector_day_skipped += 1;
        summary.day_connector_results.push(skippedResult);

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "skipped",
          rows_read: 0,
          rows_written_aggdaily: 0,
          objects_written_r2: 0,
          checkpoint_json: { skip_reason: skipDecision.reason },
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        continue;
      }

      const startedAt = nowIso();

      if (sourceKind === "r2") {
        const result: LocalToAggDailyDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "error",
          skip_reason: null,
          rows_read: 0,
          rows_written_aggdaily: 0,
          daily_rows_upserted: 0,
          monthly_rows_upserted: 0,
          error: "r2_fallback_not_implemented_in_phase1",
        };

        summary.connector_day_error += 1;
        summary.day_connector_results.push(result);

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "error",
          rows_read: 0,
          rows_written_aggdaily: 0,
          objects_written_r2: 0,
          error_json: { message: result.error },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerInsertError(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          error_json: { message: result.error },
          started_at: startedAt,
          finished_at: nowIso(),
        });
        continue;
      }

      try {
        const lookbackStartIso = addUtcHours(dayStartIso, -23);
        const sourceFetch = await fetchSourceRowsForConnector(
          sourceKind,
          connectorId,
          lookbackStartIso,
          dayEndIso,
        );

        const normalized = normalizeRowsForDay(sourceFetch.rows, dayUtc);

        let rowsWritten = 0;
        let dailyRows = 0;
        let monthlyRows = 0;

        if (DRY_RUN) {
          logStructured("info", "local_to_aggdaily_dry_run_plan", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: sourceKind,
            source_filter: sourceFetch.source_filter,
            rows_read: normalized.rowsRead,
            rows_candidate_aggdaily: normalized.helperRows.length,
          });
        } else {
          const writeSummary = await upsertAggDailyRows(
            normalized.helperRows,
            dayStartIso,
            dayEndIso,
          );
          rowsWritten = writeSummary.rowsWritten;
          dailyRows = writeSummary.dailyRows;
          monthlyRows = writeSummary.monthlyRows;
        }

        const status: LocalToAggDailyDayConnectorResult["status"] = DRY_RUN ? "dry_run" : "complete";
        const result: LocalToAggDailyDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status,
          skip_reason: null,
          rows_read: normalized.rowsRead,
          rows_written_aggdaily: rowsWritten,
          daily_rows_upserted: dailyRows,
          monthly_rows_upserted: monthlyRows,
          error: null,
        };

        summary.rows_read += normalized.rowsRead;
        summary.rows_written_aggdaily += rowsWritten;
        summary.rollup_daily_rows_upserted += dailyRows;
        summary.rollup_monthly_rows_upserted += monthlyRows;

        if (status === "complete") {
          summary.connector_day_complete += 1;
        } else {
          summary.connector_day_skipped += 1;
        }

        summary.day_connector_results.push(result);

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status,
          rows_read: normalized.rowsRead,
          rows_written_aggdaily: rowsWritten,
          objects_written_r2: 0,
          checkpoint_json: {
            source_filter: sourceFetch.source_filter,
            rows_candidate_aggdaily: normalized.helperRows.length,
            dry_run: DRY_RUN,
          },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        if (!DRY_RUN) {
          await ledgerUpsertCheckpoint(ledgerEnabled, {
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: sourceKind,
            status: "complete",
            rows_read: normalized.rowsRead,
            rows_written_aggdaily: rowsWritten,
            objects_written_r2: 0,
            checkpoint_json: {
              updated_by_run_id: runId,
              source_filter: sourceFetch.source_filter,
              completed_at: nowIso(),
            },
            updated_at: nowIso(),
          });
        }

        logStructured("info", "local_to_aggdaily_day_connector_done", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status,
          rows_read: normalized.rowsRead,
          rows_written_aggdaily: rowsWritten,
          daily_rows_upserted: dailyRows,
          monthly_rows_upserted: monthlyRows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: LocalToAggDailyDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "error",
          skip_reason: null,
          rows_read: 0,
          rows_written_aggdaily: 0,
          daily_rows_upserted: 0,
          monthly_rows_upserted: 0,
          error: message,
        };

        summary.connector_day_error += 1;
        summary.day_connector_results.push(result);

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "error",
          rows_read: 0,
          rows_written_aggdaily: 0,
          objects_written_r2: 0,
          error_json: { message },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "error",
          rows_read: 0,
          rows_written_aggdaily: 0,
          objects_written_r2: 0,
          checkpoint_json: {
            updated_by_run_id: runId,
            failed_at: nowIso(),
          },
          error_json: { message },
          updated_at: nowIso(),
        });

        await ledgerInsertError(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          error_json: { message },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        logStructured("error", "local_to_aggdaily_day_connector_failed", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          error: message,
        });
      }
    }

    summary.days_processed += 1;
  }

  return summary;
}

async function runObservsToR2Stub(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
): Promise<StubModeSummary> {
  return {
    mode: "obs_aqi_to_r2",
    run_id: runId,
    stubbed: true,
    message: "Phase 1 stub: mode wiring and trigger plumbing only. Pipeline implementation is pending.",
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: dayRangeDaysCount(window.from_day_utc, window.to_day_utc),
  };
}

async function runSourceToAllStub(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
): Promise<StubModeSummary> {
  const retentionWindow = computeRollingLocalRetentionWindow({
    nowUtc: new Date(),
    timeZone: LOCAL_TIMEZONE,
    localRetentionDays: OBS_AQI_LOCAL_RETENTION_DAYS,
  });

  const days = buildBackwardDayRange(window.from_day_utc, window.to_day_utc);
  const observsWriteEligibleDays: string[] = [];
  const observsWriteSkippedDays: string[] = [];

  for (const dayUtc of days) {
    if (isDayInRollingRetentionWindow(dayUtc, retentionWindow)) {
      observsWriteEligibleDays.push(dayUtc);
    } else {
      observsWriteSkippedDays.push(dayUtc);
    }
  }

  return {
    mode: "source_to_all",
    run_id: runId,
    stubbed: true,
    message:
      "Phase 1 stub: mode wiring only. Retention-boundary helper is active and classifies observs-write eligible vs skipped days.",
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: days.length,
    retention_window: retentionWindow,
    observs_write_eligible_days: observsWriteEligibleDays,
    observs_write_skipped_days: observsWriteSkippedDays,
  };
}

async function main(): Promise<void> {
  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const window = resolveRunWindow();
  const ledgerEnabled = await detectLedgerEnabled();

  await ledgerInsertRun(ledgerEnabled, runId, window);

  logStructured("info", "backfill_run_start", {
    run_id: runId,
    run_mode: RUN_MODE,
    trigger_mode: TRIGGER_MODE,
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    enable_r2_fallback: ENABLE_R2_FALLBACK,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    connector_ids: CONNECTOR_IDS,
    ingest_retention_days: INGEST_RETENTION_DAYS,
    observs_local_retention_days: OBS_AQI_LOCAL_RETENTION_DAYS,
    local_timezone: LOCAL_TIMEZONE,
    ledger_enabled: ledgerEnabled,
  });

  let summary: RunSummary;
  let runStatus: RunStatus = DRY_RUN ? "dry_run" : "ok";
  let errorMessage: string | null = null;

  try {
    if (RUN_MODE === "local_to_aggdaily") {
      summary = await runLocalToAggDaily(runId, window, ledgerEnabled);
      if (summary.connector_day_error > 0) {
        runStatus = "error";
        errorMessage = `local_to_aggdaily encountered ${summary.connector_day_error} connector-day errors`;
      }
    } else if (RUN_MODE === "obs_aqi_to_r2") {
      summary = await runObservsToR2Stub(runId, window);
      runStatus = "stubbed";
    } else {
      summary = await runSourceToAllStub(runId, window);
      runStatus = "stubbed";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runStatus = "error";
    errorMessage = message;
    summary = {
      mode: RUN_MODE,
      run_id: runId,
      stubbed: true,
      message: "run_failed",
      from_day_utc: window.from_day_utc,
      to_day_utc: window.to_day_utc,
      days_planned: dayRangeDaysCount(window.from_day_utc, window.to_day_utc),
    } as StubModeSummary;

    await ledgerInsertError(ledgerEnabled, {
      run_id: runId,
      run_mode: RUN_MODE,
      day_utc: null,
      connector_id: null,
      source_kind: null,
      error_json: { message },
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: nowIso(),
    });
  }

  const durationMs = Date.now() - startedAtMs;

  await ledgerUpdateRun(ledgerEnabled, runId, {
    status: runStatus,
    rows_read: "rows_read" in summary ? summary.rows_read : 0,
    rows_written_aggdaily: "rows_written_aggdaily" in summary ? summary.rows_written_aggdaily : 0,
    objects_written_r2: 0,
    checkpoint_json: {
      summary,
      connector_ids: CONNECTOR_IDS,
      enable_r2_fallback: ENABLE_R2_FALLBACK,
    },
    error_json: errorMessage ? { message: errorMessage } : null,
    finished_at: nowIso(),
  });

  const output = {
    ok: runStatus !== "error",
    run_id: runId,
    run_mode: RUN_MODE,
    trigger_mode: TRIGGER_MODE,
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    status: runStatus,
    duration_ms: durationMs,
    error: errorMessage,
    summary,
  };

  if (runStatus === "error") {
    logStructured("error", "backfill_run_failed", output);
    console.error(JSON.stringify(output));
    throw new Error(errorMessage || "backfill_run_failed");
  }

  logStructured("info", "backfill_run_complete", output);
  console.log(JSON.stringify(output));
}

if (import.meta.main) {
  await main();
}
