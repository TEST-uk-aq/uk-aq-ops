import {
  normalizeAqiAveragingCode,
  normalizeAqiCalculationStatus,
} from "../../lib/aqi/aqi_levels.mjs";
import { partitionRowsByExistingStations } from "./station_fk_guard.ts";
import { uploadDropboxErrorLog } from "../shared/dropbox_error_log.ts";
import {
  aggregateRefreshMetrics,
  buildDeepRefreshChunks,
  deepHourlyUpsertBatchSize,
  DeepHourlyUpsertChunkError,
  DeepRefreshChunkError,
} from "./reconcile_deep_refresh.ts";

type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type RunMode =
  | "sync_hourly"
  | "backfill"
  | "reconcile_short"
  | "reconcile_deep";

type HelperRow = {
  timeseries_id: number;
  station_id: number | null;
  connector_id: number;
  pollutant_code: "no2" | "pm25" | "pm10";
  timestamp_hour_utc: string;

  daqi_input_value_ugm3: number | null;
  daqi_input_averaging_code: string | null;
  daqi_index_level: number | null;
  daqi_source_observation_count: number | null;
  daqi_required_observation_count: number | null;
  daqi_calculation_status: string | null;
  daqi_missing_reason: string | null;
  eaqi_input_value_ugm3: number | null;
  eaqi_input_averaging_code: string | null;
  eaqi_index_level: number | null;
  eaqi_source_observation_count: number | null;
  eaqi_required_observation_count: number | null;
  eaqi_calculation_status: string | null;
  eaqi_missing_reason: string | null;

  hourly_sample_count: number | null;
};

type HourlyUpsertMetrics = {
  rows_attempted: number;
  rows_changed: number;
  rows_inserted: number;
  rows_updated: number;
  timeseries_hours_changed: number;
  timeseries_hours_changed_gt_cutoff: number;
  max_changed_lag_hours: number | null;
};

type RollupMetrics = {
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
};

type HelperRefreshMetrics = {
  source_rows: number;
  rows_upserted: number;
  timeseries_hours_changed: number;
  max_changed_lag_hours: number | null;
};

type StationLinkHealthMetrics = {
  null_station_rows: number;
  mismatched_station_rows: number;
  null_station_timeseries: number;
  mismatched_station_timeseries: number;
  sample_null_timeseries_ids: number[];
  sample_mismatched_timeseries_ids: number[];
};

type SyncWindow = {
  hourEndStartExclusive: Date;
  hourEndEndInclusive: Date;
  referenceHourEnd: Date;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const HELPER_WINDOW_RPC_PAGE_SIZE = 1000;

const INGEST_SUPABASE_URL = requiredEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = requiredEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQI_PRIVILEGED_KEY = requiredEnv("OBS_AQIDB_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public")
  .trim();
const HELPER_UPSERT_RPC = "uk_aq_rpc_timeseries_aqi_hourly_helper_upsert";
const HELPER_WINDOW_RPC = (Deno.env.get("UK_AQ_AQI_HELPER_WINDOW_RPC") ||
  "uk_aq_rpc_timeseries_aqi_hourly_helper_window").trim();
const HOURLY_UPSERT_RPC = (Deno.env.get("UK_AQ_AQI_HOURLY_UPSERT_RPC") ||
  "uk_aq_rpc_timeseries_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC = (Deno.env.get("UK_AQ_AQI_ROLLUP_REFRESH_RPC") ||
  "uk_aq_rpc_timeseries_aqi_rollups_refresh").trim();
const STATION_LINK_HEALTH_RPC = "uk_aq_rpc_timeseries_aqi_station_link_health";
const RUN_LOG_RPC = (Deno.env.get("UK_AQ_AQI_RUN_LOG_RPC") ||
  "uk_aq_rpc_aqi_compute_run_log").trim();
const RUN_CLEANUP_RPC = (Deno.env.get("UK_AQ_AQI_RUN_CLEANUP_RPC") ||
  "uk_aq_rpc_aqi_compute_runs_cleanup").trim();

const RUN_MODE = parseRunMode(
  Deno.env.get("UK_AQ_AQI_RUN_MODE"),
  "sync_hourly",
);
const RECONCILE_SHORT_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RECONCILE_SHORT_HOURS"),
  8,
);
const RECONCILE_DEEP_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RECONCILE_DEEP_HOURS"),
  36,
);
const RECONCILE_DEEP_REFRESH_CHUNK_HOURS = Math.min(
  parsePositiveInt(
    Deno.env.get("UK_AQ_AQI_RECONCILE_DEEP_REFRESH_CHUNK_HOURS"),
    6,
  ),
  RECONCILE_DEEP_HOURS,
);
const TRIGGER_MODE =
  (Deno.env.get("UK_AQ_AQI_TRIGGER_MODE") || "manual").trim() || "manual";
const MATURITY_DELAY_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_MATURITY_DELAY_HOURS"),
  3,
);
const MATURITY_DELAY_BUFFER_MINUTES = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_MATURITY_DELAY_BUFFER_MINUTES"),
  10,
);
const LATE_CHANGE_CUTOFF_HOURS = 36;
const RPC_RETRIES = parsePositiveInt(Deno.env.get("UK_AQ_AQI_RPC_RETRIES"), 3);
const HOURLY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_HOURLY_UPSERT_CHUNK_SIZE"),
  2000,
);
const RUN_LOG_RETENTION_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RUN_LOG_RETENTION_DAYS"),
  7,
);
const FROM_HOUR_UTC = optionalEnv("UK_AQ_AQI_FROM_HOUR_UTC");
const TO_HOUR_UTC = optionalEnv("UK_AQ_AQI_TO_HOUR_UTC");
const TIMESERIES_IDS = parseTimeseriesIdsCsv(
  optionalEnv("UK_AQ_AQI_TIMESERIES_IDS_CSV"),
);
const SERVICE_NAME = "uk-aq-timeseries-aqi-hourly";
const STATION_ID_QUERY_CHUNK_SIZE = 500;
const SKIPPED_ROW_SAMPLE_LIMIT = 20;
const STATION_FK_CHECK_SCHEMA =
  (Deno.env.get("UK_AQ_AQI_STATION_FK_CHECK_SCHEMA") || "uk_aq_public").trim();
const STATION_FK_CHECK_VIEW =
  (Deno.env.get("UK_AQ_AQI_STATION_FK_CHECK_VIEW") || "stations_fk_check")
    .trim();
const DROPBOX_APP_KEY = optionalEnv("DROPBOX_APP_KEY") || "";
const DROPBOX_APP_SECRET = optionalEnv("DROPBOX_APP_SECRET") || "";
const DROPBOX_REFRESH_TOKEN = optionalEnv("DROPBOX_REFRESH_TOKEN") || "";
const UK_AQ_DROPBOX_ROOT = optionalEnv("UK_AQ_DROPBOX_ROOT") || "";

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
  throw new Error(
    `Missing required environment variable: one of ${names.join(", ")}`,
  );
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
    value === "sync_hourly" ||
    value === "backfill" ||
    value === "reconcile_short" ||
    value === "reconcile_deep"
  ) {
    return value;
  }
  return fallback;
}

function parseTimeseriesIdsCsv(raw: string | null): number[] | null {
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
  return status === 429 || status === 500 || status === 502 || status === 503 ||
    status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postgrestRpc<T>(
  baseUrl: string,
  privilegedKey: string,
  rpcName: string,
  args: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<RpcResult<T>> {
  const queryString = query && query.toString() ? `?${query.toString()}` : "";
  const url = `${normalizeUrl(baseUrl)}/rpc/${rpcName}${queryString}`;
  const headers: Record<string, string> = {
    apikey: privilegedKey,
    Authorization: `Bearer ${privilegedKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Profile": RPC_SCHEMA,
    "Content-Profile": RPC_SCHEMA,
    "x-ukaq-egress-caller": "uk_aq_timeseries_aqi_hourly_cloud_run",
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

async function fetchExistingStationIds(
  stationIds: number[],
): Promise<Set<number>> {
  const existing = new Set<number>();
  const distinctIds = Array.from(new Set(stationIds)).sort((a, b) => a - b);
  for (const ids of chunkRows(distinctIds, STATION_ID_QUERY_CHUNK_SIZE)) {
    const query = new URLSearchParams({
      select: "id",
      id: `in.(${ids.join(",")})`,
    });
    const url = `${
      normalizeUrl(OBS_AQIDB_SUPABASE_URL)
    }/${STATION_FK_CHECK_VIEW}?${query.toString()}`;
    let completed = false;
    let finalError = "unknown_station_preflight_error";
    for (let attempt = 1; attempt <= RPC_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            apikey: OBS_AQI_PRIVILEGED_KEY,
            Authorization: `Bearer ${OBS_AQI_PRIVILEGED_KEY}`,
            Accept: "application/json",
            "Accept-Profile": STATION_FK_CHECK_SCHEMA,
            "x-ukaq-egress-caller": "uk_aq_timeseries_aqi_hourly_cloud_run",
          },
        });
        const payload = await response.json().catch(() => null);
        if (response.ok && Array.isArray(payload)) {
          for (const row of payload) {
            const id = Number((row as Record<string, unknown>).id);
            if (Number.isInteger(id) && id > 0) existing.add(Math.trunc(id));
          }
          completed = true;
          break;
        }
        finalError = asErrorMessage(payload, response.status);
        if (attempt < RPC_RETRIES && isRetryableStatus(response.status)) {
          await sleep(Math.min(5000, 1000 * attempt));
          continue;
        }
        break;
      } catch (error) {
        finalError = error instanceof Error ? error.message : String(error);
        if (attempt < RPC_RETRIES) {
          await sleep(Math.min(5000, 1000 * attempt));
          continue;
        }
      }
    }
    if (!completed) {
      throw new Error(`station FK preflight failed: ${finalError}`);
    }
  }
  return existing;
}

function isStationForeignKeyError(message: string): boolean {
  return message.includes("timeseries_aqi_hourly_station_id_fkey") ||
    (
      message.includes('table "timeseries_aqi_hourly"') &&
      message.toLowerCase().includes("foreign key")
    );
}

function skippedRowSample(rows: HelperRow[]): Array<Record<string, unknown>> {
  return rows.slice(0, SKIPPED_ROW_SAMPLE_LIMIT).map((row) => ({
    station_id: row.station_id,
    timeseries_id: row.timeseries_id,
    connector_id: row.connector_id,
    pollutant_code: row.pollutant_code,
    timestamp_hour_utc: row.timestamp_hour_utc,
  }));
}

async function logMissingStationFk(
  event: "missing_station_fk" | "missing_station_fk_unhandled_by_preflight",
  window: SyncWindow,
  details: Record<string, unknown>,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const missingStationIds = Array.isArray(details.missing_station_ids)
    ? details.missing_station_ids.filter(
      (value): value is number => Number.isInteger(value) && Number(value) > 0,
    )
    : [];
  const payload = {
    id: crypto.randomUUID(),
    created_at: createdAt,
    source: "cloud_run",
    severity: "error",
    message: String(details.message || event),
    service: SERVICE_NAME,
    context: {
      error_type: event,
      run_mode: RUN_MODE,
      trigger_mode: TRIGGER_MODE,
      window_start_utc: hourIso(window.hourEndStartExclusive),
      window_end_utc: hourIso(window.hourEndEndInclusive),
      source_file: "workers/uk_aq_timeseries_aqi_hourly_cloud_run/run_job.ts",
      ...details,
    },
    connector_id: null,
    station_id: missingStationIds.length === 1 ? missingStationIds[0] : null,
    timeseries_id: null,
    connector_code: null,
    dropbox_path: null,
  };
  console.error(JSON.stringify({
    timestamp_utc: createdAt,
    level: "error",
    event,
    ...payload,
  }));
  try {
    const dropboxPath = await uploadDropboxErrorLog({
      appKey: DROPBOX_APP_KEY,
      appSecret: DROPBOX_APP_SECRET,
      refreshToken: DROPBOX_REFRESH_TOKEN,
      dropboxRoot: UK_AQ_DROPBOX_ROOT,
      serviceCode: "timeseries_aqi_hourly",
      payload,
    });
    if (!dropboxPath) {
      console.error(JSON.stringify({
        level: "warning",
        event: "missing_station_fk_dropbox_not_configured",
        error_id: payload.id,
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "warning",
      event: "missing_station_fk_dropbox_upload_failed",
      error_id: payload.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
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

function buildRollingWindow(referenceHourEnd: Date, hours: number): SyncWindow {
  return {
    hourEndStartExclusive: addHours(referenceHourEnd, -hours),
    hourEndEndInclusive: referenceHourEnd,
    referenceHourEnd,
  };
}

function runWindow(nowUtc: Date): SyncWindow {
  const totalDelayMs = MATURITY_DELAY_HOURS * ONE_HOUR_MS +
    MATURITY_DELAY_BUFFER_MINUTES * ONE_MINUTE_MS;
  const targetHourEnd = floorUtcHour(new Date(nowUtc.getTime() - totalDelayMs));

  if (RUN_MODE === "backfill") {
    if (!FROM_HOUR_UTC || !TO_HOUR_UTC) {
      throw new Error(
        "Backfill mode requires UK_AQ_AQI_FROM_HOUR_UTC and UK_AQ_AQI_TO_HOUR_UTC",
      );
    }
    const fromHourEnd = parseIsoHour(FROM_HOUR_UTC);
    const toHourEnd = parseIsoHour(TO_HOUR_UTC);
    if (toHourEnd.getTime() < fromHourEnd.getTime()) {
      throw new Error(
        "UK_AQ_AQI_TO_HOUR_UTC must be >= UK_AQ_AQI_FROM_HOUR_UTC",
      );
    }
    return {
      hourEndStartExclusive: addHours(fromHourEnd, -1),
      hourEndEndInclusive: toHourEnd,
      referenceHourEnd: targetHourEnd,
    };
  }

  if (RUN_MODE === "reconcile_short") {
    return buildRollingWindow(targetHourEnd, RECONCILE_SHORT_HOURS);
  }

  if (RUN_MODE === "reconcile_deep") {
    return buildRollingWindow(targetHourEnd, RECONCILE_DEEP_HOURS);
  }

  return buildRollingWindow(targetHourEnd, 1);
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

function toNullableInt(value: unknown): number | null {
  const parsed = toNullableNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseHelperRows(payload: unknown): HelperRow[] {
  if (!Array.isArray(payload)) {
    throw new Error("helper window RPC returned non-array payload");
  }

  const rows: HelperRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const timeseriesId = Number(row.timeseries_id);
    const connectorId = Number(row.connector_id);
    const pollutantCode = String(row.pollutant_code || "").trim().toLowerCase();
    const stationId = row.station_id === null || row.station_id === undefined
      ? null
      : Number(row.station_id);
    const timestampRaw = String(row.timestamp_hour_utc || "").trim();
    if (
      !Number.isInteger(timeseriesId) || timeseriesId <= 0 ||
      !Number.isInteger(connectorId) || connectorId <= 0 ||
      (pollutantCode !== "no2" && pollutantCode !== "pm25" &&
        pollutantCode !== "pm10") ||
      Number.isNaN(Date.parse(timestampRaw))
    ) {
      continue;
    }

    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id:
        Number.isInteger(stationId) && stationId !== null && stationId > 0
          ? Math.trunc(stationId)
          : null,
      connector_id: Math.trunc(connectorId),
      pollutant_code: pollutantCode as "no2" | "pm25" | "pm10",
      timestamp_hour_utc: hourIso(new Date(Date.parse(timestampRaw))),
      daqi_input_value_ugm3: toNullableNumber(row.daqi_input_value_ugm3),
      daqi_input_averaging_code: normalizeAqiAveragingCode(
        row.daqi_input_averaging_code,
      ),
      daqi_index_level: toNullableInt(row.daqi_index_level),
      daqi_source_observation_count: toNullableInt(
        row.daqi_source_observation_count,
      ),
      daqi_required_observation_count: toNullableInt(
        row.daqi_required_observation_count,
      ),
      daqi_calculation_status: normalizeAqiCalculationStatus(
        row.daqi_calculation_status,
      ),
      daqi_missing_reason: typeof row.daqi_missing_reason === "string"
        ? row.daqi_missing_reason
        : null,
      eaqi_input_value_ugm3: toNullableNumber(row.eaqi_input_value_ugm3),
      eaqi_input_averaging_code: normalizeAqiAveragingCode(
        row.eaqi_input_averaging_code,
      ),
      eaqi_index_level: toNullableInt(row.eaqi_index_level),
      eaqi_source_observation_count: toNullableInt(
        row.eaqi_source_observation_count,
      ),
      eaqi_required_observation_count: toNullableInt(
        row.eaqi_required_observation_count,
      ),
      eaqi_calculation_status: normalizeAqiCalculationStatus(
        row.eaqi_calculation_status,
      ),
      eaqi_missing_reason: typeof row.eaqi_missing_reason === "string"
        ? row.eaqi_missing_reason
        : null,
      hourly_sample_count: toNullableInt(row.hourly_sample_count),
    });
  }

  rows.sort((a, b) => {
    if (a.timestamp_hour_utc < b.timestamp_hour_utc) return -1;
    if (a.timestamp_hour_utc > b.timestamp_hour_utc) return 1;
    return a.timeseries_id - b.timeseries_id;
  });

  return rows;
}

function toSafeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
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
    timeseries_hours_changed: toSafeInt(
      row.timeseries_hours_changed ?? row.station_hours_changed,
    ),
    timeseries_hours_changed_gt_cutoff: toSafeInt(
      row.timeseries_hours_changed_gt_cutoff ??
        row.station_hours_changed_gt_cutoff,
    ),
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

function parseHelperRefreshMetrics(payload: unknown): HelperRefreshMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("helper upsert RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    source_rows: toSafeInt(row.source_rows),
    rows_upserted: toSafeInt(row.rows_upserted),
    timeseries_hours_changed: toSafeInt(
      row.timeseries_hours_changed ?? row.station_hours_changed,
    ),
    max_changed_lag_hours: toNullableNumber(row.max_changed_lag_hours),
  };
}

function parseIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: number[] = [];
  for (const item of value) {
    const parsed = Number(item);
    if (Number.isInteger(parsed) && parsed > 0) {
      out.push(Math.trunc(parsed));
    }
  }
  return out;
}

function parseStationLinkHealthMetrics(
  payload: unknown,
): StationLinkHealthMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("station link health RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    null_station_rows: toSafeInt(row.null_station_rows),
    mismatched_station_rows: toSafeInt(row.mismatched_station_rows),
    null_station_timeseries: toSafeInt(row.null_station_timeseries),
    mismatched_station_timeseries: toSafeInt(row.mismatched_station_timeseries),
    sample_null_timeseries_ids: parseIntArray(row.sample_null_timeseries_ids),
    sample_mismatched_timeseries_ids: parseIntArray(
      row.sample_mismatched_timeseries_ids,
    ),
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

async function fetchHelperRowsPage(
  window: SyncWindow,
  offset: number,
): Promise<HelperRow[]> {
  const args: Record<string, unknown> = {
    p_hour_end_start_exclusive: hourIso(window.hourEndStartExclusive),
    p_hour_end_end_inclusive: hourIso(window.hourEndEndInclusive),
  };
  if (TIMESERIES_IDS && TIMESERIES_IDS.length > 0) {
    args.p_timeseries_ids = TIMESERIES_IDS;
  }
  const query = new URLSearchParams({
    limit: String(HELPER_WINDOW_RPC_PAGE_SIZE),
    offset: String(offset),
  });

  const result = await postgrestRpc<unknown>(
    INGEST_SUPABASE_URL,
    INGEST_PRIVILEGED_KEY,
    HELPER_WINDOW_RPC,
    args,
    query,
  );
  if (result.error) {
    throw new Error(`helper window RPC failed: ${result.error.message}`);
  }
  return parseHelperRows(result.data);
}

function shouldRefreshHelperWindow(): boolean {
  return RUN_MODE === "reconcile_short" || RUN_MODE === "reconcile_deep";
}

async function refreshHelperWindow(
  window: SyncWindow,
): Promise<HelperRefreshMetrics> {
  const args: Record<string, unknown> = {
    p_hour_end_start_exclusive: hourIso(window.hourEndStartExclusive),
    p_hour_end_end_inclusive: hourIso(window.hourEndEndInclusive),
    p_reference_hour_end_utc: hourIso(window.referenceHourEnd),
  };
  if (TIMESERIES_IDS && TIMESERIES_IDS.length > 0) {
    args.p_timeseries_ids = TIMESERIES_IDS;
  }

  const result = await postgrestRpc<unknown>(
    INGEST_SUPABASE_URL,
    INGEST_PRIVILEGED_KEY,
    HELPER_UPSERT_RPC,
    args,
  );
  if (result.error) {
    throw new Error(`helper upsert RPC failed: ${result.error.message}`);
  }
  return parseHelperRefreshMetrics(result.data);
}

async function refreshDeepHelperWindow(
  window: SyncWindow,
): Promise<{ metrics: HelperRefreshMetrics; chunkCount: number }> {
  const chunks = buildDeepRefreshChunks(
    window,
    RECONCILE_DEEP_REFRESH_CHUNK_HOURS,
  );
  const metrics: HelperRefreshMetrics[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const startedAt = Date.now();
    try {
      const chunkMetrics = await refreshHelperWindow({
        ...chunk,
        referenceHourEnd: window.referenceHourEnd,
      });
      metrics.push(chunkMetrics);
      console.log(JSON.stringify({
        level: "info",
        event: "aqi_reconcile_deep_helper_refresh_chunk",
        run_mode: RUN_MODE,
        trigger_mode: TRIGGER_MODE,
        chunk_index: index + 1,
        chunk_count: chunks.length,
        chunk_start_utc: hourIso(chunk.hourEndStartExclusive),
        chunk_end_utc: hourIso(chunk.hourEndEndInclusive),
        ...chunkMetrics,
        duration_ms: Date.now() - startedAt,
      }));
    } catch (error) {
      const rpcError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: "error",
        event: "aqi_reconcile_deep_helper_refresh_chunk_failed",
        run_mode: RUN_MODE,
        trigger_mode: TRIGGER_MODE,
        full_window_start_utc: hourIso(window.hourEndStartExclusive),
        full_window_end_utc: hourIso(window.hourEndEndInclusive),
        chunk_index: index + 1,
        chunk_count: chunks.length,
        chunk_start_utc: hourIso(chunk.hourEndStartExclusive),
        chunk_end_utc: hourIso(chunk.hourEndEndInclusive),
        rpc_error: rpcError,
        duration_ms: Date.now() - startedAt,
      }));
      throw new DeepRefreshChunkError(
        window,
        chunk,
        index + 1,
        chunks.length,
        rpcError,
      );
    }
  }
  return {
    metrics: aggregateRefreshMetrics(metrics),
    chunkCount: chunks.length,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const nowUtc = new Date();
  const window = runWindow(nowUtc);

  const referenceHourStart = addHours(window.referenceHourEnd, -1);
  const lateCutoffHour = addHours(
    referenceHourStart,
    -LATE_CHANGE_CUTOFF_HOURS,
  );

  let sourceRowsCount = 0;
  let candidateTimeseriesHours = 0;
  let rowsUpserted = 0;
  let rowsChanged = 0;
  let timeseriesHoursChanged = 0;
  let timeseriesHoursChangedGt36h = 0;
  let maxChangedLagHours: number | null = null;
  let dailyRowsUpserted = 0;
  let monthlyRowsUpserted = 0;
  let helperPagesFetched = 0;
  let helperRefreshMetrics: HelperRefreshMetrics | null = null;
  let helperRefreshChunkCount = 0;
  let helperRefreshFailedChunkStartUtc: string | null = null;
  let helperRefreshFailedChunkEndUtc: string | null = null;
  let hourlyUpsertChunkCount = 0;
  let hourlyUpsertFailedChunkStartUtc: string | null = null;
  let hourlyUpsertFailedChunkEndUtc: string | null = null;
  let stationLinkHealth: StationLinkHealthMetrics | null = null;
  let runStatus: "ok" | "error" = "ok";
  let errorMessage: string | null = null;
  const missingStationFkIds = new Set<number>();
  let skippedMissingStationFkRows = 0;

  try {
    if (shouldRefreshHelperWindow()) {
      if (RUN_MODE === "reconcile_deep") {
        const deepRefresh = await refreshDeepHelperWindow(window);
        helperRefreshMetrics = deepRefresh.metrics;
        helperRefreshChunkCount = deepRefresh.chunkCount;
      } else {
        helperRefreshMetrics = await refreshHelperWindow(window);
        helperRefreshChunkCount = 1;
      }
    }

    const timeseriesIds = new Set<number>();
    const hourlyUpsertWindows = RUN_MODE === "reconcile_deep"
      ? buildDeepRefreshChunks(window, RECONCILE_DEEP_REFRESH_CHUNK_HOURS)
      : [window];
    hourlyUpsertChunkCount = hourlyUpsertWindows.length;

    for (
      let windowIndex = 0;
      windowIndex < hourlyUpsertWindows.length;
      windowIndex += 1
    ) {
      const hourlyUpsertWindow = hourlyUpsertWindows[windowIndex];
      const hourlyUpsertSyncWindow: SyncWindow = {
        ...hourlyUpsertWindow,
        referenceHourEnd: window.referenceHourEnd,
      };
      const chunkStartedAt = Date.now();
      const chunkSourceRowsBefore = sourceRowsCount;
      const chunkRowsUpsertedBefore = rowsUpserted;
      let helperOffset = 0;

      try {
        while (true) {
          const helperRows = await fetchHelperRowsPage(
            hourlyUpsertSyncWindow,
            helperOffset,
          );
          helperPagesFetched += 1;
          sourceRowsCount += helperRows.length;
          candidateTimeseriesHours += helperRows.length;

          if (helperRows.length === 0) {
            break;
          }

          const candidateStationIds = helperRows
            .map((row) => row.station_id)
            .filter((stationId): stationId is number => stationId !== null);
          const existingStationIds = await fetchExistingStationIds(
            candidateStationIds,
          );
          const stationPartition = partitionRowsByExistingStations(
            helperRows,
            existingStationIds,
          );
          for (const stationId of stationPartition.missingStationIds) {
            missingStationFkIds.add(stationId);
          }
          skippedMissingStationFkRows += stationPartition.skippedRows.length;
          if (stationPartition.skippedRows.length > 0) {
            await logMissingStationFk(
              "missing_station_fk",
              hourlyUpsertSyncWindow,
              {
                missing_station_ids: stationPartition.missingStationIds,
                missing_station_fk_count:
                  stationPartition.missingStationIds.length,
                skipped_row_count: stationPartition.skippedRows.length,
                sample_skipped_rows: skippedRowSample(
                  stationPartition.skippedRows,
                ),
                message:
                  "Rows with missing parent stations were skipped; valid rows continued.",
              },
            );
          }

          const chunks = chunkRows(
            stationPartition.validRows,
            RUN_MODE === "reconcile_deep"
              ? deepHourlyUpsertBatchSize(HOURLY_UPSERT_CHUNK_SIZE)
              : Math.max(100, HOURLY_UPSERT_CHUNK_SIZE),
          );
          for (
            let batchIndex = 0;
            batchIndex < chunks.length;
            batchIndex += 1
          ) {
            const chunk = chunks[batchIndex];
            const batchStartedAt = Date.now();
            const upsertResult = await postgrestRpc<unknown>(
              OBS_AQIDB_SUPABASE_URL,
              OBS_AQI_PRIVILEGED_KEY,
              HOURLY_UPSERT_RPC,
              {
                p_rows: chunk,
                p_late_cutoff_hour: hourIso(lateCutoffHour),
                p_reference_hour: hourIso(referenceHourStart),
              },
            );
            if (upsertResult.error) {
              if (RUN_MODE === "reconcile_deep") {
                const batchTimestamps = chunk.map((row) =>
                  row.timestamp_hour_utc
                );
                console.error(JSON.stringify({
                  level: "error",
                  event: "aqi_reconcile_deep_hourly_upsert_rpc_batch_failed",
                  run_mode: RUN_MODE,
                  trigger_mode: TRIGGER_MODE,
                  chunk_index: windowIndex + 1,
                  chunk_count: hourlyUpsertWindows.length,
                  chunk_start_utc: hourIso(
                    hourlyUpsertWindow.hourEndStartExclusive,
                  ),
                  chunk_end_utc: hourIso(
                    hourlyUpsertWindow.hourEndEndInclusive,
                  ),
                  helper_page_offset: helperOffset,
                  batch_index: batchIndex + 1,
                  batch_count: chunks.length,
                  batch_row_count: chunk.length,
                  first_timestamp_hour_utc: batchTimestamps.length > 0
                    ? batchTimestamps.reduce((first, value) =>
                      value < first ? value : first
                    )
                    : null,
                  last_timestamp_hour_utc: batchTimestamps.length > 0
                    ? batchTimestamps.reduce((last, value) =>
                      value > last ? value : last
                    )
                    : null,
                  sample_timeseries_ids: Array.from(
                    new Set(chunk.slice(0, 5).map((row) => row.timeseries_id)),
                  ),
                  rpc_error: upsertResult.error.message,
                  duration_ms: Date.now() - batchStartedAt,
                }));
              }
              if (isStationForeignKeyError(upsertResult.error.message)) {
                await logMissingStationFk(
                  "missing_station_fk_unhandled_by_preflight",
                  hourlyUpsertSyncWindow,
                  {
                    rpc_name: HOURLY_UPSERT_RPC,
                    error_text: upsertResult.error.message,
                    attempted_row_count: chunk.length,
                    message:
                      "Station FK failure remained after preflight; the run is failing because the offending row could not be identified safely.",
                  },
                );
              }
              throw new Error(
                `hourly upsert RPC failed: ${upsertResult.error.message}`,
              );
            }
            const metrics = parseHourlyUpsertMetrics(upsertResult.data);
            if (RUN_MODE === "reconcile_deep") {
              console.log(JSON.stringify({
                level: "info",
                event: "aqi_reconcile_deep_hourly_upsert_rpc_batch",
                run_mode: RUN_MODE,
                trigger_mode: TRIGGER_MODE,
                chunk_index: windowIndex + 1,
                chunk_count: hourlyUpsertWindows.length,
                chunk_start_utc: hourIso(
                  hourlyUpsertWindow.hourEndStartExclusive,
                ),
                chunk_end_utc: hourIso(hourlyUpsertWindow.hourEndEndInclusive),
                helper_page_offset: helperOffset,
                batch_index: batchIndex + 1,
                batch_count: chunks.length,
                batch_row_count: chunk.length,
                rows_changed: metrics.rows_changed,
                timeseries_hours_changed: metrics.timeseries_hours_changed,
                duration_ms: Date.now() - batchStartedAt,
              }));
            }
            rowsUpserted += metrics.rows_changed;
            rowsChanged += metrics.rows_changed;
            timeseriesHoursChanged += metrics.timeseries_hours_changed;
            timeseriesHoursChangedGt36h +=
              metrics.timeseries_hours_changed_gt_cutoff;
            if (metrics.max_changed_lag_hours !== null) {
              maxChangedLagHours = maxChangedLagHours === null
                ? metrics.max_changed_lag_hours
                : Math.max(maxChangedLagHours, metrics.max_changed_lag_hours);
            }
          }

          for (const row of stationPartition.validRows) {
            timeseriesIds.add(row.timeseries_id);
          }

          if (helperRows.length < HELPER_WINDOW_RPC_PAGE_SIZE) {
            break;
          }
          helperOffset += HELPER_WINDOW_RPC_PAGE_SIZE;
        }
      } catch (error) {
        if (RUN_MODE !== "reconcile_deep") {
          throw error;
        }
        const rpcError = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          level: "error",
          event: "aqi_reconcile_deep_hourly_upsert_chunk_failed",
          run_mode: RUN_MODE,
          trigger_mode: TRIGGER_MODE,
          full_window_start_utc: hourIso(window.hourEndStartExclusive),
          full_window_end_utc: hourIso(window.hourEndEndInclusive),
          chunk_index: windowIndex + 1,
          chunk_count: hourlyUpsertWindows.length,
          chunk_start_utc: hourIso(hourlyUpsertWindow.hourEndStartExclusive),
          chunk_end_utc: hourIso(hourlyUpsertWindow.hourEndEndInclusive),
          source_rows: sourceRowsCount - chunkSourceRowsBefore,
          rows_upserted: rowsUpserted - chunkRowsUpsertedBefore,
          rpc_error: rpcError,
          duration_ms: Date.now() - chunkStartedAt,
        }));
        throw new DeepHourlyUpsertChunkError(
          window,
          hourlyUpsertWindow,
          windowIndex + 1,
          hourlyUpsertWindows.length,
          rpcError,
        );
      }

      if (RUN_MODE === "reconcile_deep") {
        console.log(JSON.stringify({
          level: "info",
          event: "aqi_reconcile_deep_hourly_upsert_chunk",
          run_mode: RUN_MODE,
          trigger_mode: TRIGGER_MODE,
          chunk_index: windowIndex + 1,
          chunk_count: hourlyUpsertWindows.length,
          chunk_start_utc: hourIso(hourlyUpsertWindow.hourEndStartExclusive),
          chunk_end_utc: hourIso(hourlyUpsertWindow.hourEndEndInclusive),
          source_rows: sourceRowsCount - chunkSourceRowsBefore,
          rows_upserted: rowsUpserted - chunkRowsUpsertedBefore,
          duration_ms: Date.now() - chunkStartedAt,
        }));
      }
    }

    if (timeseriesIds.size > 0) {
      const rollupResult = await postgrestRpc<unknown>(
        OBS_AQIDB_SUPABASE_URL,
        OBS_AQI_PRIVILEGED_KEY,
        ROLLUP_REFRESH_RPC,
        {
          p_start_hour_utc: hourIso(window.hourEndStartExclusive),
          p_end_hour_utc: hourIso(window.hourEndEndInclusive),
          p_timeseries_ids: Array.from(timeseriesIds),
        },
      );
      if (rollupResult.error) {
        throw new Error(
          `rollup refresh RPC failed: ${rollupResult.error.message}`,
        );
      }
      const rollupMetrics = parseRollupMetrics(rollupResult.data);
      dailyRowsUpserted = rollupMetrics.daily_rows_upserted;
      monthlyRowsUpserted = rollupMetrics.monthly_rows_upserted;

      const healthResult = await postgrestRpc<unknown>(
        OBS_AQIDB_SUPABASE_URL,
        OBS_AQI_PRIVILEGED_KEY,
        STATION_LINK_HEALTH_RPC,
        {
          p_start_hour_utc: hourIso(window.hourEndStartExclusive),
          p_end_hour_utc: hourIso(window.hourEndEndInclusive),
          p_timeseries_ids: Array.from(timeseriesIds),
        },
      );
      if (healthResult.error) {
        console.error(JSON.stringify({
          level: "error",
          event: "aqi_station_link_health_rpc_failed",
          message: healthResult.error.message,
        }));
      } else {
        stationLinkHealth = parseStationLinkHealthMetrics(healthResult.data);
        if (
          stationLinkHealth.null_station_rows > 0 ||
          stationLinkHealth.mismatched_station_rows > 0
        ) {
          console.error(JSON.stringify({
            level: "error",
            event: "aqi_station_link_anomaly",
            run_mode: RUN_MODE,
            trigger_mode: TRIGGER_MODE,
            window_start_utc: hourIso(window.hourEndStartExclusive),
            window_end_utc: hourIso(window.hourEndEndInclusive),
            null_station_rows: stationLinkHealth.null_station_rows,
            mismatched_station_rows: stationLinkHealth.mismatched_station_rows,
            null_station_timeseries: stationLinkHealth.null_station_timeseries,
            mismatched_station_timeseries:
              stationLinkHealth.mismatched_station_timeseries,
            sample_null_timeseries_ids:
              stationLinkHealth.sample_null_timeseries_ids,
            sample_mismatched_timeseries_ids:
              stationLinkHealth.sample_mismatched_timeseries_ids,
          }));
        }
      }
    }
  } catch (error) {
    if (error instanceof DeepRefreshChunkError) {
      helperRefreshChunkCount = error.chunkCount;
      helperRefreshFailedChunkStartUtc = error.chunkStartUtc;
      helperRefreshFailedChunkEndUtc = error.chunkEndUtc;
    }
    if (error instanceof DeepHourlyUpsertChunkError) {
      hourlyUpsertChunkCount = error.chunkCount;
      hourlyUpsertFailedChunkStartUtc = error.chunkStartUtc;
      hourlyUpsertFailedChunkEndUtc = error.chunkEndUtc;
    }
    runStatus = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const durationMs = Date.now() - startedAt;
  const deepReconcileEffective = RUN_MODE === "reconcile_deep";

  const runLogResult = await postgrestRpc<unknown>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
    RUN_LOG_RPC,
    {
      p_run_mode: RUN_MODE,
      p_trigger_mode: TRIGGER_MODE,
      p_window_start_utc: hourIso(window.hourEndStartExclusive),
      p_window_end_utc: hourIso(window.hourEndEndInclusive),
      p_source_rows: sourceRowsCount,
      p_candidate_station_hours: candidateTimeseriesHours,
      p_rows_upserted: rowsUpserted,
      p_rows_changed: rowsChanged,
      p_station_hours_changed: timeseriesHoursChanged,
      p_station_hours_changed_gt_36h: timeseriesHoursChangedGt36h,
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
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
    window_start_utc: hourIso(window.hourEndStartExclusive),
    window_end_utc: hourIso(window.hourEndEndInclusive),
    source_rows: sourceRowsCount,
    candidate_timeseries_hours: candidateTimeseriesHours,
    rows_upserted: rowsUpserted,
    rows_changed: rowsChanged,
    timeseries_hours_changed: timeseriesHoursChanged,
    timeseries_hours_changed_gt_36h: timeseriesHoursChangedGt36h,
    max_changed_lag_hours: maxChangedLagHours,
    daily_rows_upserted: dailyRowsUpserted,
    monthly_rows_upserted: monthlyRowsUpserted,
    helper_pages_fetched: helperPagesFetched,
    helper_refresh_source_rows: helperRefreshMetrics?.source_rows ?? null,
    helper_refresh_rows_upserted: helperRefreshMetrics?.rows_upserted ?? null,
    helper_refresh_timeseries_hours_changed:
      helperRefreshMetrics?.timeseries_hours_changed ?? null,
    helper_refresh_max_changed_lag_hours:
      helperRefreshMetrics?.max_changed_lag_hours ?? null,
    helper_refresh_chunk_count: helperRefreshChunkCount,
    helper_refresh_chunk_hours: RUN_MODE === "reconcile_deep"
      ? RECONCILE_DEEP_REFRESH_CHUNK_HOURS
      : null,
    helper_refresh_chunked: RUN_MODE === "reconcile_deep" &&
      helperRefreshChunkCount > 1,
    helper_refresh_failed_chunk_start_utc: helperRefreshFailedChunkStartUtc,
    helper_refresh_failed_chunk_end_utc: helperRefreshFailedChunkEndUtc,
    hourly_upsert_chunk_count: hourlyUpsertChunkCount,
    hourly_upsert_chunk_hours: RUN_MODE === "reconcile_deep"
      ? RECONCILE_DEEP_REFRESH_CHUNK_HOURS
      : null,
    hourly_upsert_chunked: RUN_MODE === "reconcile_deep" &&
      hourlyUpsertChunkCount > 1,
    hourly_upsert_failed_chunk_start_utc: hourlyUpsertFailedChunkStartUtc,
    hourly_upsert_failed_chunk_end_utc: hourlyUpsertFailedChunkEndUtc,
    station_link_null_rows: stationLinkHealth?.null_station_rows ?? null,
    station_link_mismatched_rows: stationLinkHealth?.mismatched_station_rows ??
      null,
    station_link_null_timeseries: stationLinkHealth?.null_station_timeseries ??
      null,
    station_link_mismatched_timeseries:
      stationLinkHealth?.mismatched_station_timeseries ?? null,
    station_link_sample_null_timeseries_ids:
      stationLinkHealth?.sample_null_timeseries_ids ?? null,
    station_link_sample_mismatched_timeseries_ids:
      stationLinkHealth?.sample_mismatched_timeseries_ids ?? null,
    missing_station_fk_count: missingStationFkIds.size,
    missing_station_fk_ids: Array.from(missingStationFkIds).sort((a, b) =>
      a - b
    ),
    skipped_missing_station_fk_rows: skippedMissingStationFkRows,
    continued_after_missing_station_fk: missingStationFkIds.size > 0,
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
