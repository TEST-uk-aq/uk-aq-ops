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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2DeleteObjects,
  r2GetObject,
  r2HeadObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../shared/r2_sigv4.mjs";

type RunMode = "local_to_aqilevels" | "obs_aqi_to_r2" | "source_to_all";
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

type ObsHistoryRow = {
  timeseries_id: number;
  observed_at: string;
  value: number | null;
};

type ObsHistoryParquetRow = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
};

type AqilevelsHistoryRow = {
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
  daqi_no2_index_level: number | null;
  daqi_pm25_rolling24h_index_level: number | null;
  daqi_pm10_rolling24h_index_level: number | null;
  eaqi_no2_index_level: number | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm10_index_level: number | null;
};

type AqilevelsHistoryParquetRow = {
  connector_id: number;
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
  daqi_no2_index_level: number | null;
  daqi_pm25_rolling24h_index_level: number | null;
  daqi_pm10_rolling24h_index_level: number | null;
  eaqi_no2_index_level: number | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm10_index_level: number | null;
};

type ObsHistoryFileEntry = {
  key: string;
  row_count: number;
  bytes: number;
  etag_or_hash: string | null;
};

type ObsConnectorManifest = {
  day_utc: string;
  connector_id: number;
  run_id: string;
  manifest_key: string;
  source_row_count: number;
  min_observed_at: string | null;
  max_observed_at: string | null;
  parquet_object_keys: string[];
  file_count: number;
  total_bytes: number;
  files: ObsHistoryFileEntry[];
};

type AqilevelsConnectorManifest = {
  day_utc: string;
  connector_id: number;
  run_id: string;
  manifest_key: string;
  source_row_count: number;
  min_timestamp_hour_utc: string | null;
  max_timestamp_hour_utc: string | null;
  parquet_object_keys: string[];
  file_count: number;
  total_bytes: number;
  files: ObsHistoryFileEntry[];
};

type ObsAqiToR2DayConnectorResult = {
  day_utc: string;
  connector_id: number;
  status: "complete" | "skipped" | "error" | "dry_run";
  skip_reason: string | null;
  rows_read: number;
  objects_written_r2: number;
  manifest_key: string | null;
  error: string | null;
};

type HourlyUpsertMetrics = {
  rows_changed: number;
  station_hours_changed: number;
};

type RollupMetrics = {
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
};

type LocalToAqilevelsDayConnectorResult = {
  day_utc: string;
  connector_id: number;
  source_kind: SourceKind;
  status: "complete" | "skipped" | "error" | "dry_run";
  skip_reason: string | null;
  rows_read: number;
  rows_written_aqilevels: number;
  daily_rows_upserted: number;
  monthly_rows_upserted: number;
  error: string | null;
};

type LocalToAqilevelsSummary = {
  mode: "local_to_aqilevels";
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
  rows_written_aqilevels: number;
  rollup_daily_rows_upserted: number;
  rollup_monthly_rows_upserted: number;
  day_connector_results: LocalToAqilevelsDayConnectorResult[];
};

type ObsAqiToR2Summary = {
  mode: "obs_aqi_to_r2";
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
  objects_written_r2: number;
  backed_up_days: string[];
  pending_backfill_days: string[];
  exported_days: string[];
  failed_days: string[];
  day_connector_results: ObsAqiToR2DayConnectorResult[];
  min_day_utc: string | null;
  max_day_utc: string | null;
  message: string;
};

type SourceToAllSummary = {
  mode: "source_to_all";
  run_id: string;
  dry_run: boolean;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
  rows_read: number;
  rows_written_aqilevels: number;
  retention_window: Record<string, unknown>;
  local_to_aqilevels_days: string[];
  source_acquisition_pending_days: string[];
  local_to_aqilevels_summary: LocalToAqilevelsSummary | null;
  warnings: string[];
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

type RunFailureSummary = {
  mode: RunMode;
  run_id: string;
  failed: true;
  message: string;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
};

type RunSummary =
  | LocalToAqilevelsSummary
  | ObsAqiToR2Summary
  | SourceToAllSummary
  | StubModeSummary
  | RunFailureSummary;

const INGEST_SUPABASE_URL = optionalEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = optionalEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = optionalEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQI_PRIVILEGED_KEY = optionalEnv("OBS_AQIDB_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public").trim();
const OPS_SCHEMA = (Deno.env.get("UK_AQ_BACKFILL_OPS_SCHEMA") || "uk_aq_ops").trim();

const HOURLY_FINGERPRINT_RPC = (Deno.env.get("UK_AQ_BACKFILL_HOURLY_FINGERPRINT_RPC") ||
  "uk_aq_rpc_observations_hourly_fingerprint").trim();
const SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_source").trim();
const HOURLY_UPSERT_RPC = (Deno.env.get("UK_AQ_BACKFILL_AQILEVELS_HOURLY_UPSERT_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC = (Deno.env.get("UK_AQ_BACKFILL_AQILEVELS_ROLLUP_REFRESH_RPC") ||
  "uk_aq_rpc_station_aqi_rollups_refresh").trim();
const OBS_R2_SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_OBS_R2_SOURCE_RPC") ||
  "uk_aq_rpc_observs_history_day_rows").trim();
const AQI_R2_SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC") ||
  "uk_aq_rpc_aqilevels_history_day_rows").trim();
const AQI_R2_CONNECTOR_COUNTS_RPC = (Deno.env.get("UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC") ||
  "uk_aq_rpc_aqilevels_history_day_connector_counts").trim();

const HISTORY_OBSERVATIONS_SCHEMA_NAME = "observations";
const HISTORY_OBSERVATIONS_SCHEMA_VERSION = 2;
const HISTORY_OBSERVATIONS_WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_OBSERVATIONS_COLUMNS = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
]);
const HISTORY_AQILEVELS_SCHEMA_NAME = "aqilevels";
const HISTORY_AQILEVELS_SCHEMA_VERSION = 1;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v1";
const HISTORY_AQILEVELS_COLUMNS = Object.freeze([
  "connector_id",
  "station_id",
  "timestamp_hour_utc",
  "no2_hourly_mean_ugm3",
  "pm25_hourly_mean_ugm3",
  "pm10_hourly_mean_ugm3",
  "pm25_rolling24h_mean_ugm3",
  "pm10_rolling24h_mean_ugm3",
  "no2_hourly_sample_count",
  "pm25_hourly_sample_count",
  "pm10_hourly_sample_count",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
]);

const OBS_R2_DEPLOY_ENV = (Deno.env.get("UK_AQ_DEPLOY_ENV") || Deno.env.get("DEPLOY_ENV") || "dev")
  .trim()
  .toLowerCase();
const OBS_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX") || "history/v1/observations",
) || "history/v1/observations";
const AQI_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX") || "history/v1/aqilevels",
) || "history/v1/aqilevels";
const OBS_R2_WRITER_GIT_SHA = (Deno.env.get("GITHUB_SHA") || "").trim() || null;
const OBS_R2_CONFIG = {
  endpoint: (Deno.env.get("CFLARE_R2_ENDPOINT") || Deno.env.get("R2_ENDPOINT") || "").trim(),
  bucket: resolveR2BucketByDeployEnv(),
  region: (Deno.env.get("CFLARE_R2_REGION") || Deno.env.get("R2_REGION") || "auto").trim() || "auto",
  access_key_id: (Deno.env.get("CFLARE_R2_ACCESS_KEY_ID") || Deno.env.get("R2_ACCESS_KEY_ID") || "").trim(),
  secret_access_key: (Deno.env.get("CFLARE_R2_SECRET_ACCESS_KEY") || Deno.env.get("R2_SECRET_ACCESS_KEY") || "")
    .trim(),
};

const RUN_MODE = parseRunMode(
  Deno.env.get("UK_AQ_BACKFILL_RUN_MODE"),
  "local_to_aqilevels",
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
const ALLOW_STUB_MODES = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_ALLOW_STUB_MODES"),
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
const OBS_R2_SOURCE_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OBS_R2_PAGE_SIZE"),
  20000,
  1000,
  100000,
);
const OBS_R2_SOURCE_MAX_PAGES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OBS_R2_MAX_PAGES"),
  50000,
  10,
  1000000,
);
const HOURLY_UPSERT_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_HOURLY_UPSERT_CHUNK_SIZE"),
  2000,
  100,
  10000,
);
const OBS_R2_PART_MAX_ROWS = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_PART_MAX_ROWS"),
  1000000,
  1000,
  5000000,
);
const OBS_R2_ROW_GROUP_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_ROW_GROUP_SIZE"),
  100000,
  10000,
  2000000,
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
const TEXT_ENCODER = new TextEncoder();

const SOURCE_METADATA_SCHEMA = (Deno.env.get("UK_AQ_BACKFILL_METADATA_SCHEMA") || "uk_aq_core").trim();

function nowIso(): string {
  return new Date().toISOString();
}

function encodeJsonBody(payload: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(payload, null, 2));
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

function resolveR2BucketByDeployEnv(): string {
  const explicit = optionalEnvAny(["CFLARE_R2_BUCKET", "R2_BUCKET"]);
  if (explicit) {
    return explicit;
  }

  if (OBS_R2_DEPLOY_ENV === "prod" || OBS_R2_DEPLOY_ENV === "production") {
    return optionalEnv("R2_BUCKET_PROD") || "";
  }
  if (OBS_R2_DEPLOY_ENV === "stage" || OBS_R2_DEPLOY_ENV === "staging") {
    return optionalEnv("R2_BUCKET_STAGE") || "";
  }
  return optionalEnv("R2_BUCKET_DEV") || "";
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

type ObsHistorySourceCursor = {
  after_timeseries_id: number | null;
  after_observed_at: string | null;
};

type AqilevelsHistorySourceCursor = {
  after_station_id: number | null;
  after_timestamp_hour_utc: string | null;
};

let obsR2SourceRpcAvailable: boolean | null = null;
let aqiR2SourceRpcAvailable: boolean | null = null;
let aqiR2ConnectorCountsRpcAvailable: boolean | null = null;
let parquetWasmInitialized = false;
const PARQUET_WRITER_PROPERTIES_CACHE = new Map<string, unknown>();

function chunkList<T>(values: T[], chunkSize: number): T[][] {
  if (values.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function parseOptionalDay(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  const parsed = parseIsoDayUtc(text);
  if (parsed) {
    return parsed;
  }
  const isoPrefix = text.slice(0, 10);
  return parseIsoDayUtc(isoPrefix);
}

function buildObsDayManifestKey(dayUtc: string): string {
  return `${OBS_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/manifest.json`;
}

function buildAqiDayManifestKey(dayUtc: string): string {
  return `${AQI_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/manifest.json`;
}

function buildObsConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${OBS_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildAqiConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${AQI_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildObsConnectorManifestKey(dayUtc: string, connectorId: number): string {
  return `${buildObsConnectorPrefix(dayUtc, connectorId)}/manifest.json`;
}

function buildAqiConnectorManifestKey(dayUtc: string, connectorId: number): string {
  return `${buildAqiConnectorPrefix(dayUtc, connectorId)}/manifest.json`;
}

function buildObsPartKey(dayUtc: string, connectorId: number, partIndex: number): string {
  return `${buildObsConnectorPrefix(dayUtc, connectorId)}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

function buildAqiPartKey(dayUtc: string, connectorId: number, partIndex: number): string {
  return `${buildAqiConnectorPrefix(dayUtc, connectorId)}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

function dayBoundsFromIsoDay(dayUtc: string): { start_iso: string; end_iso: string } {
  return {
    start_iso: utcDayStartIso(dayUtc),
    end_iso: utcDayStartIso(shiftIsoDay(dayUtc, 1)),
  };
}

async function fetchR2BackedUpDaySet(
  dayUtcList: string[],
  options?: { day_manifest_prefix?: string },
): Promise<Set<string>> {
  const backedUp = new Set<string>();
  if (!dayUtcList.length) {
    return backedUp;
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error("obs_aqi_to_r2 requires CFLARE_R2_* / R2_* environment variables.");
  }

  const dayManifestPrefix = normalizePrefix(options?.day_manifest_prefix || OBS_R2_HISTORY_PREFIX)
    || OBS_R2_HISTORY_PREFIX;

  for (const dayUtc of dayUtcList) {
    const key = `${dayManifestPrefix}/day_utc=${dayUtc}/manifest.json`;
    const head = await r2HeadObject({
      r2: OBS_R2_CONFIG,
      key,
    });
    if (head.exists) {
      backedUp.add(dayUtc);
    }
  }
  return backedUp;
}

function normalizeObsHistoryRows(payload: unknown): ObsHistoryRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const rows: ObsHistoryRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const timeseriesId = Number(record.timeseries_id);
    const observedAtRaw = typeof record.observed_at === "string"
      ? record.observed_at
      : String(record.observed_at || "");
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
      continue;
    }
    const observedAtMs = Date.parse(observedAtRaw);
    if (!Number.isFinite(observedAtMs)) {
      continue;
    }
    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      observed_at: new Date(observedAtMs).toISOString(),
      value: toSafeNumber(record.value),
    });
  }

  rows.sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.observed_at < right.observed_at) return -1;
    if (left.observed_at > right.observed_at) return 1;
    return 0;
  });

  return rows;
}

function isRpcMissingError(message: string, status: number): boolean {
  if (status === 404) {
    return true;
  }
  const text = message.toLowerCase();
  return (
    text.includes("could not find the function") ||
    text.includes("function") && text.includes("does not exist") ||
    text.includes("schema cache")
  );
}

async function fetchObsHistoryRowsPageViaRpc(
  source: SourceDbConfig,
  args: {
    day_utc: string;
    connector_id: number;
    cursor: ObsHistorySourceCursor;
    limit: number;
  },
): Promise<{ rows: ObsHistoryRow[]; missing_rpc: boolean }> {
  const response = await postgrestRpc<unknown[]>(
    source,
    OBS_R2_SOURCE_RPC,
    {
      p_day_utc: args.day_utc,
      p_connector_id: args.connector_id,
      p_after_timeseries_id: args.cursor.after_timeseries_id,
      p_after_observed_at: args.cursor.after_observed_at,
      p_limit: args.limit,
    },
  );
  if (response.error) {
    if (isRpcMissingError(response.error.message, response.status)) {
      return { rows: [], missing_rpc: true };
    }
    throw new Error(
      `obs_aqi_to_r2 source RPC failed for day=${args.day_utc} connector=${args.connector_id}: ${response.error.message}`,
    );
  }
  return {
    rows: normalizeObsHistoryRows(response.data),
    missing_rpc: false,
  };
}

async function fetchObsHistoryRowsPageViaTable(
  source: SourceDbConfig,
  args: {
    day_utc: string;
    connector_id: number;
    cursor: ObsHistorySourceCursor;
    limit: number;
  },
): Promise<ObsHistoryRow[]> {
  const bounds = dayBoundsFromIsoDay(args.day_utc);
  const query = new URLSearchParams();
  query.set("select", "timeseries_id,observed_at,value");
  query.set("connector_id", `eq.${args.connector_id}`);
  query.append("observed_at", `gte.${bounds.start_iso}`);
  query.append("observed_at", `lt.${bounds.end_iso}`);
  if (args.cursor.after_timeseries_id !== null && args.cursor.after_observed_at) {
    query.set(
      "or",
      `(` +
        `timeseries_id.gt.${args.cursor.after_timeseries_id},` +
        `and(timeseries_id.eq.${args.cursor.after_timeseries_id},observed_at.gt.${args.cursor.after_observed_at})` +
      `)`,
    );
  }
  query.set("order", "timeseries_id.asc,observed_at.asc");
  query.set("limit", String(args.limit));

  const result = await postgrestTable<unknown[]>(
    source.base_url,
    source.privileged_key,
    {
      method: "GET",
      schema: "uk_aq_observs",
      table: "observations",
      query,
    },
  );

  if (result.error) {
    throw new Error(
      `obs_aqi_to_r2 table fallback failed for day=${args.day_utc} connector=${args.connector_id}: ${result.error}`,
    );
  }

  return normalizeObsHistoryRows(result.data);
}

async function fetchObsHistoryRowsPage(
  dayUtc: string,
  connectorId: number,
  cursor: ObsHistorySourceCursor,
  limit: number,
): Promise<ObsHistoryRow[]> {
  const source = SOURCE_DB_BY_KIND.obs_aqidb;
  if (!source) {
    throw new Error("obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }

  if (obsR2SourceRpcAvailable !== false) {
    const shouldLogFallback = obsR2SourceRpcAvailable === null;
    const rpcResult = await fetchObsHistoryRowsPageViaRpc(source, {
      day_utc: dayUtc,
      connector_id: connectorId,
      cursor,
      limit,
    });
    if (!rpcResult.missing_rpc) {
      obsR2SourceRpcAvailable = true;
      return rpcResult.rows;
    }
    if (shouldLogFallback) {
      logStructured("warning", "obs_aqi_to_r2_source_rpc_missing_fallback_table", {
        rpc_name: OBS_R2_SOURCE_RPC,
      });
    }
    obsR2SourceRpcAvailable = false;
  }

  return await fetchObsHistoryRowsPageViaTable(source, {
    day_utc: dayUtc,
    connector_id: connectorId,
    cursor,
    limit,
  });
}

function normalizeAqilevelsHistoryRows(payload: unknown): AqilevelsHistoryRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const rows: AqilevelsHistoryRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const stationId = Number(record.station_id);
    const timestampRaw = typeof record.timestamp_hour_utc === "string"
      ? record.timestamp_hour_utc
      : String(record.timestamp_hour_utc || "");
    const timestampMs = Date.parse(timestampRaw);
    if (!Number.isInteger(stationId) || stationId <= 0 || !Number.isFinite(timestampMs)) {
      continue;
    }

    const timestamp = new Date(timestampMs);
    timestamp.setUTCMinutes(0, 0, 0);

    rows.push({
      station_id: Math.trunc(stationId),
      timestamp_hour_utc: timestamp.toISOString(),
      no2_hourly_mean_ugm3: toSafeNumber(record.no2_hourly_mean_ugm3),
      pm25_hourly_mean_ugm3: toSafeNumber(record.pm25_hourly_mean_ugm3),
      pm10_hourly_mean_ugm3: toSafeNumber(record.pm10_hourly_mean_ugm3),
      pm25_rolling24h_mean_ugm3: toSafeNumber(record.pm25_rolling24h_mean_ugm3),
      pm10_rolling24h_mean_ugm3: toSafeNumber(record.pm10_rolling24h_mean_ugm3),
      no2_hourly_sample_count: toSafeNumber(record.no2_hourly_sample_count),
      pm25_hourly_sample_count: toSafeNumber(record.pm25_hourly_sample_count),
      pm10_hourly_sample_count: toSafeNumber(record.pm10_hourly_sample_count),
      daqi_no2_index_level: toSafeNumber(record.daqi_no2_index_level),
      daqi_pm25_rolling24h_index_level: toSafeNumber(record.daqi_pm25_rolling24h_index_level),
      daqi_pm10_rolling24h_index_level: toSafeNumber(record.daqi_pm10_rolling24h_index_level),
      eaqi_no2_index_level: toSafeNumber(record.eaqi_no2_index_level),
      eaqi_pm25_index_level: toSafeNumber(record.eaqi_pm25_index_level),
      eaqi_pm10_index_level: toSafeNumber(record.eaqi_pm10_index_level),
    });
  }

  rows.sort((left, right) => {
    if (left.station_id !== right.station_id) {
      return left.station_id - right.station_id;
    }
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return 0;
  });

  return rows;
}

async function fetchAqilevelsConnectorCountsForDay(dayUtc: string): Promise<Map<number, number>> {
  const source = SOURCE_DB_BY_KIND.obs_aqidb;
  if (!source) {
    throw new Error("obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }

  const response = await postgrestRpc<unknown[]>(
    source,
    AQI_R2_CONNECTOR_COUNTS_RPC,
    {
      p_day_utc: dayUtc,
      p_connector_ids: null,
    },
  );
  if (response.error) {
    if (isRpcMissingError(response.error.message, response.status)) {
      if (aqiR2ConnectorCountsRpcAvailable !== false) {
        logStructured("error", "obs_aqi_to_r2_aqi_connector_counts_rpc_missing", {
          rpc_name: AQI_R2_CONNECTOR_COUNTS_RPC,
          status: response.status,
        });
      }
      aqiR2ConnectorCountsRpcAvailable = false;
      throw new Error(
        `obs_aqi_to_r2 requires ${AQI_R2_CONNECTOR_COUNTS_RPC} RPC (uk_aq_public) for AQI connector-day export`,
      );
    }
    throw new Error(
      `obs_aqi_to_r2 AQI connector counts RPC failed for day=${dayUtc}: ${response.error.message}`,
    );
  }

  aqiR2ConnectorCountsRpcAvailable = true;
  const counts = new Map<number, number>();
  const rows = Array.isArray(response.data) ? response.data : [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const connectorId = Number(row.connector_id);
    const rowCount = Number(row.row_count);
    if (!Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    if (!Number.isFinite(rowCount) || rowCount <= 0) {
      continue;
    }
    counts.set(Math.trunc(connectorId), Math.max(0, Math.trunc(rowCount)));
  }
  return counts;
}

async function fetchAqilevelsHistoryRowsPageViaRpc(
  source: SourceDbConfig,
  args: {
    day_utc: string;
    connector_id: number;
    cursor: AqilevelsHistorySourceCursor;
    limit: number;
  },
): Promise<AqilevelsHistoryRow[]> {
  const response = await postgrestRpc<unknown[]>(
    source,
    AQI_R2_SOURCE_RPC,
    {
      p_day_utc: args.day_utc,
      p_connector_id: args.connector_id,
      p_after_station_id: args.cursor.after_station_id,
      p_after_timestamp_hour_utc: args.cursor.after_timestamp_hour_utc,
      p_limit: args.limit,
    },
  );
  if (response.error) {
    if (isRpcMissingError(response.error.message, response.status)) {
      if (aqiR2SourceRpcAvailable !== false) {
        logStructured("error", "obs_aqi_to_r2_aqi_source_rpc_missing", {
          rpc_name: AQI_R2_SOURCE_RPC,
          status: response.status,
        });
      }
      aqiR2SourceRpcAvailable = false;
      throw new Error(`obs_aqi_to_r2 requires ${AQI_R2_SOURCE_RPC} RPC (uk_aq_public) for AQI export`);
    }
    throw new Error(
      `obs_aqi_to_r2 AQI source RPC failed for day=${args.day_utc} connector=${args.connector_id}: ${response.error.message}`,
    );
  }

  aqiR2SourceRpcAvailable = true;
  return normalizeAqilevelsHistoryRows(response.data);
}

async function fetchAqilevelsHistoryRowsPage(
  dayUtc: string,
  connectorId: number,
  cursor: AqilevelsHistorySourceCursor,
  limit: number,
): Promise<AqilevelsHistoryRow[]> {
  const source = SOURCE_DB_BY_KIND.obs_aqidb;
  if (!source) {
    throw new Error("obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }

  return await fetchAqilevelsHistoryRowsPageViaRpc(source, {
    day_utc: dayUtc,
    connector_id: connectorId,
    cursor,
    limit,
  });
}

function averageNumber(total: number, count: number): number | null {
  if (!count) {
    return null;
  }
  return total / count;
}

function statsFromFileEntries(fileEntries: ObsHistoryFileEntry[], totalRows: number) {
  if (!fileEntries.length) {
    return {
      bytes_per_row_estimate: totalRows > 0 ? null : 0,
      avg_file_bytes: 0,
      min_file_bytes: 0,
      max_file_bytes: 0,
    };
  }

  const bytes = fileEntries.map((entry) => Number(entry.bytes || 0));
  const totalBytes = bytes.reduce((sum, value) => sum + value, 0);
  let minBytes = bytes[0];
  let maxBytes = bytes[0];
  for (let i = 1; i < bytes.length; i += 1) {
    const value = bytes[i];
    if (value < minBytes) minBytes = value;
    if (value > maxBytes) maxBytes = value;
  }

  return {
    bytes_per_row_estimate: totalRows > 0 ? totalBytes / totalRows : null,
    avg_file_bytes: averageNumber(totalBytes, bytes.length),
    min_file_bytes: minBytes,
    max_file_bytes: maxBytes,
  };
}

function withManifestHash<T extends Record<string, unknown>>(payloadWithoutHash: T): T & { manifest_hash: string } {
  return {
    ...payloadWithoutHash,
    manifest_hash: sha256Hex(JSON.stringify(payloadWithoutHash)),
  };
}

function createObsConnectorManifest(args: {
  dayUtc: string;
  connectorId: number;
  runId: string;
  manifestKey: string;
  sourceRowCount: number;
  minObservedAt: string | null;
  maxObservedAt: string | null;
  fileEntries: ObsHistoryFileEntry[];
  writerGitSha: string | null;
  backedUpAtUtc: string;
}): ObsConnectorManifest & { [key: string]: unknown } {
  const parquetObjectKeys = args.fileEntries.map((entry) => entry.key);
  const totalBytes = args.fileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const stats = statsFromFileEntries(args.fileEntries, args.sourceRowCount);

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    min_observed_at: args.minObservedAt,
    max_observed_at: args.maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: args.fileEntries.length,
    total_bytes: totalBytes,
    files: args.fileEntries,
    history_schema_name: HISTORY_OBSERVATIONS_SCHEMA_NAME,
    history_schema_version: HISTORY_OBSERVATIONS_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: HISTORY_OBSERVATIONS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function createObsDayManifest(args: {
  dayUtc: string;
  runId: string;
  connectorManifests: Array<ObsConnectorManifest & Record<string, unknown>>;
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.connectorManifests.flatMap((manifest) =>
    (Array.isArray(manifest.files) ? manifest.files : []).map((entry) => ({
      connector_id: manifest.connector_id,
      key: entry.key,
      bytes: entry.bytes,
      row_count: entry.row_count,
      etag_or_hash: entry.etag_or_hash,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key))).sort((a, b) =>
    a.localeCompare(b)
  );
  const totalRows = args.connectorManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, file) => sum + toSafeInt(file.bytes), 0);
  const connectorIds = args.connectorManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  let minObservedAt: string | null = null;
  let maxObservedAt: string | null = null;
  for (const manifest of args.connectorManifests) {
    const minValue = typeof manifest.min_observed_at === "string"
      ? manifest.min_observed_at
      : null;
    const maxValue = typeof manifest.max_observed_at === "string"
      ? manifest.max_observed_at
      : null;
    if (minValue && (!minObservedAt || minValue < minObservedAt)) {
      minObservedAt = minValue;
    }
    if (maxValue && (!maxObservedAt || maxValue > maxObservedAt)) {
      maxObservedAt = maxValue;
    }
  }

  const stats = statsFromFileEntries(
    files.map((entry) => ({
      key: entry.key,
      row_count: toSafeInt(entry.row_count),
      bytes: toSafeInt(entry.bytes),
      etag_or_hash: typeof entry.etag_or_hash === "string" ? entry.etag_or_hash : null,
    })),
    totalRows,
  );

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: args.runId,
    source_row_count: totalRows,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: args.connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
    })),
    history_schema_name: HISTORY_OBSERVATIONS_SCHEMA_NAME,
    history_schema_version: HISTORY_OBSERVATIONS_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: HISTORY_OBSERVATIONS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function createAqiConnectorManifest(args: {
  dayUtc: string;
  connectorId: number;
  runId: string;
  manifestKey: string;
  sourceRowCount: number;
  minTimestampHourUtc: string | null;
  maxTimestampHourUtc: string | null;
  fileEntries: ObsHistoryFileEntry[];
  writerGitSha: string | null;
  backedUpAtUtc: string;
}): AqilevelsConnectorManifest & { [key: string]: unknown } {
  const parquetObjectKeys = args.fileEntries.map((entry) => entry.key);
  const totalBytes = args.fileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const stats = statsFromFileEntries(args.fileEntries, args.sourceRowCount);

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    min_timestamp_hour_utc: args.minTimestampHourUtc,
    max_timestamp_hour_utc: args.maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: args.fileEntries.length,
    total_bytes: totalBytes,
    files: args.fileEntries,
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function createAqiDayManifest(args: {
  dayUtc: string;
  runId: string;
  connectorManifests: Array<AqilevelsConnectorManifest & Record<string, unknown>>;
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.connectorManifests.flatMap((manifest) =>
    (Array.isArray(manifest.files) ? manifest.files : []).map((entry) => ({
      connector_id: manifest.connector_id,
      key: entry.key,
      bytes: entry.bytes,
      row_count: entry.row_count,
      etag_or_hash: entry.etag_or_hash,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key))).sort((a, b) =>
    a.localeCompare(b)
  );
  const totalRows = args.connectorManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, file) => sum + toSafeInt(file.bytes), 0);
  const connectorIds = args.connectorManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;
  for (const manifest of args.connectorManifests) {
    const minValue = typeof manifest.min_timestamp_hour_utc === "string"
      ? manifest.min_timestamp_hour_utc
      : null;
    const maxValue = typeof manifest.max_timestamp_hour_utc === "string"
      ? manifest.max_timestamp_hour_utc
      : null;
    if (minValue && (!minTimestampHourUtc || minValue < minTimestampHourUtc)) {
      minTimestampHourUtc = minValue;
    }
    if (maxValue && (!maxTimestampHourUtc || maxValue > maxTimestampHourUtc)) {
      maxTimestampHourUtc = maxValue;
    }
  }

  const stats = statsFromFileEntries(
    files.map((entry) => ({
      key: entry.key,
      row_count: toSafeInt(entry.row_count),
      bytes: toSafeInt(entry.bytes),
      etag_or_hash: typeof entry.etag_or_hash === "string" ? entry.etag_or_hash : null,
    })),
    totalRows,
  );

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: args.runId,
    source_row_count: totalRows,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: args.connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
    })),
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function ensureParquetWasmInitialized(): void {
  if (parquetWasmInitialized) {
    return;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.resolve(moduleDir, "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  (parquetWasm as unknown as { initSync: (args: { module: Uint8Array }) => void }).initSync({
    module: wasmBytes,
  });
  parquetWasmInitialized = true;
}

function parquetWriterProperties(rowGroupSize: number, createdBy: string): unknown {
  const sizeKey = Number(rowGroupSize);
  const cacheKey = `${sizeKey}:${createdBy}`;
  if (PARQUET_WRITER_PROPERTIES_CACHE.has(cacheKey)) {
    return PARQUET_WRITER_PROPERTIES_CACHE.get(cacheKey) || null;
  }
  ensureParquetWasmInitialized();
  const parquetAny = parquetWasm as any;
  const writerProperties = new parquetAny.WriterPropertiesBuilder()
    .setCompression(parquetAny.Compression.ZSTD)
    .setMaxRowGroupSize(sizeKey)
    .setCreatedBy(createdBy)
    .build();
  PARQUET_WRITER_PROPERTIES_CACHE.set(cacheKey, writerProperties);
  return writerProperties;
}

function rowsToParquetBuffer(rows: ObsHistoryParquetRow[]): Uint8Array {
  ensureParquetWasmInitialized();
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
    tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
  }).tableFromArrays({
    connector_id: Int32Array.from(rows.map((row) => row.connector_id)),
    timeseries_id: Int32Array.from(rows.map((row) => row.timeseries_id)),
    observed_at: rows.map((row) => new Date(row.observed_at)),
    value: rows.map((row) => (row.value === null || row.value === undefined ? null : Number(row.value))),
  });
  const wasmTable = (parquetWasm as unknown as {
    Table: { fromIPCStream: (bytes: Uint8Array) => unknown };
  }).Table.fromIPCStream(
    (arrow as unknown as { tableToIPC: (table: unknown, mode: "stream") => Uint8Array }).tableToIPC(
      table,
      "stream",
    ),
  );
  return (parquetWasm as unknown as {
    writeParquet: (table: unknown, writerProperties: unknown) => Uint8Array;
  }).writeParquet(
    wasmTable,
    parquetWriterProperties(OBS_R2_ROW_GROUP_SIZE, HISTORY_OBSERVATIONS_WRITER_VERSION),
  );
}

function rowsToAqiParquetBuffer(rows: AqilevelsHistoryParquetRow[]): Uint8Array {
  ensureParquetWasmInitialized();
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
    tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
  }).tableFromArrays({
    connector_id: rows.map((row) => row.connector_id),
    station_id: rows.map((row) => row.station_id),
    timestamp_hour_utc: rows.map((row) => new Date(row.timestamp_hour_utc)),
    no2_hourly_mean_ugm3: rows.map((row) => row.no2_hourly_mean_ugm3),
    pm25_hourly_mean_ugm3: rows.map((row) => row.pm25_hourly_mean_ugm3),
    pm10_hourly_mean_ugm3: rows.map((row) => row.pm10_hourly_mean_ugm3),
    pm25_rolling24h_mean_ugm3: rows.map((row) => row.pm25_rolling24h_mean_ugm3),
    pm10_rolling24h_mean_ugm3: rows.map((row) => row.pm10_rolling24h_mean_ugm3),
    no2_hourly_sample_count: rows.map((row) => row.no2_hourly_sample_count),
    pm25_hourly_sample_count: rows.map((row) => row.pm25_hourly_sample_count),
    pm10_hourly_sample_count: rows.map((row) => row.pm10_hourly_sample_count),
    daqi_no2_index_level: rows.map((row) => row.daqi_no2_index_level),
    daqi_pm25_rolling24h_index_level: rows.map((row) => row.daqi_pm25_rolling24h_index_level),
    daqi_pm10_rolling24h_index_level: rows.map((row) => row.daqi_pm10_rolling24h_index_level),
    eaqi_no2_index_level: rows.map((row) => row.eaqi_no2_index_level),
    eaqi_pm25_index_level: rows.map((row) => row.eaqi_pm25_index_level),
    eaqi_pm10_index_level: rows.map((row) => row.eaqi_pm10_index_level),
  });
  const wasmTable = (parquetWasm as unknown as {
    Table: { fromIPCStream: (bytes: Uint8Array) => unknown };
  }).Table.fromIPCStream(
    (arrow as unknown as { tableToIPC: (table: unknown, mode: "stream") => Uint8Array }).tableToIPC(
      table,
      "stream",
    ),
  );
  return (parquetWasm as unknown as {
    writeParquet: (table: unknown, writerProperties: unknown) => Uint8Array;
  }).writeParquet(
    wasmTable,
    parquetWriterProperties(OBS_R2_ROW_GROUP_SIZE, HISTORY_AQILEVELS_WRITER_VERSION),
  );
}

async function deleteR2Prefix(prefix: string): Promise<void> {
  const entries = await r2ListAllObjects({
    r2: OBS_R2_CONFIG,
    prefix: `${prefix}/`,
    max_keys: 1000,
  });
  const keys = entries.map((entry) => String(entry.key || "").trim()).filter(Boolean);
  if (!keys.length) {
    return;
  }
  for (const batch of chunkList(keys, 1000)) {
    const result = await r2DeleteObjects({ r2: OBS_R2_CONFIG, keys: batch });
    if (result.errors.length > 0) {
      throw new Error(`R2 delete prefix failed (${prefix}): ${JSON.stringify(result.errors.slice(0, 10))}`);
    }
  }
}

async function loadExistingConnectorManifest(dayUtc: string, connectorId: number): Promise<ObsConnectorManifest | null> {
  const key = buildObsConnectorManifestKey(dayUtc, connectorId);
  const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
  if (!head.exists) {
    return null;
  }
  const object = await r2GetObject({ r2: OBS_R2_CONFIG, key });
  let parsed: unknown;
  try {
    parsed = JSON.parse(object.body.toString("utf8"));
  } catch {
    throw new Error(`Invalid existing connector manifest JSON: ${key}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing connector manifest is not an object: ${key}`);
  }
  const record = parsed as Record<string, unknown>;
  const filesRaw = Array.isArray(record.files) ? record.files : [];
  const files: ObsHistoryFileEntry[] = filesRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const item = entry as Record<string, unknown>;
      const fileKey = String(item.key || "").trim();
      if (!fileKey) {
        return null;
      }
      return {
        key: fileKey,
        row_count: toSafeInt(item.row_count),
        bytes: toSafeInt(item.bytes),
        etag_or_hash: item.etag_or_hash === null || item.etag_or_hash === undefined
          ? null
          : String(item.etag_or_hash),
      };
    })
    .filter((value): value is ObsHistoryFileEntry => value !== null);

  return {
    day_utc: parseOptionalDay(record.day_utc) || dayUtc,
    connector_id: Number(record.connector_id) || connectorId,
    run_id: String(record.run_id || ""),
    manifest_key: String(record.manifest_key || key).trim() || key,
    source_row_count: toSafeInt(record.source_row_count),
    min_observed_at: typeof record.min_observed_at === "string" ? record.min_observed_at : null,
    max_observed_at: typeof record.max_observed_at === "string" ? record.max_observed_at : null,
    parquet_object_keys: Array.isArray(record.parquet_object_keys)
      ? record.parquet_object_keys.map((value) => String(value || "").trim()).filter(Boolean)
      : files.map((file) => file.key),
    file_count: toSafeInt(record.file_count) || files.length,
    total_bytes: toSafeInt(record.total_bytes) || files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

async function exportObsConnectorDayToR2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  manifest_key: string;
  connector_manifest: ObsConnectorManifest & Record<string, unknown>;
}> {
  if (FORCE_REPLACE) {
    await deleteR2Prefix(buildObsConnectorPrefix(args.day_utc, args.connector_id));
  }

  const parquetRowsBuffer: ObsHistoryParquetRow[] = [];
  const fileEntries: ObsHistoryFileEntry[] = [];
  let rowsRead = 0;
  let partIndex = 0;
  let pageCount = 0;
  let minObservedAt: string | null = null;
  let maxObservedAt: string | null = null;
  let cursor: ObsHistorySourceCursor = {
    after_timeseries_id: null,
    after_observed_at: null,
  };

  const flushPart = async (): Promise<void> => {
    if (!parquetRowsBuffer.length) {
      return;
    }
    const partRows = parquetRowsBuffer.splice(0, parquetRowsBuffer.length);
    const partKey = buildObsPartKey(args.day_utc, args.connector_id, partIndex);
    const parquetBuffer = rowsToParquetBuffer(partRows);
    const putResult = await r2PutObject({
      r2: OBS_R2_CONFIG,
      key: partKey,
      body: parquetBuffer,
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing parquet part after upload: ${partKey}`);
    }
    fileEntries.push({
      key: partKey,
      row_count: partRows.length,
      bytes: typeof head.bytes === "number" && Number.isFinite(head.bytes)
        ? Math.trunc(head.bytes)
        : Math.trunc(putResult.bytes),
      etag_or_hash: head.etag || putResult.etag || null,
    });
    partIndex += 1;
  };

  while (true) {
    pageCount += 1;
    if (pageCount > OBS_R2_SOURCE_MAX_PAGES) {
      throw new Error(
        `obs_aqi_to_r2 observations export exceeded max pages (${OBS_R2_SOURCE_MAX_PAGES}) for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }

    const pageRows = await fetchObsHistoryRowsPage(
      args.day_utc,
      args.connector_id,
      cursor,
      OBS_R2_SOURCE_PAGE_SIZE,
    );
    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      rowsRead += 1;
      if (!minObservedAt || row.observed_at < minObservedAt) {
        minObservedAt = row.observed_at;
      }
      if (!maxObservedAt || row.observed_at > maxObservedAt) {
        maxObservedAt = row.observed_at;
      }
      parquetRowsBuffer.push({
        connector_id: args.connector_id,
        timeseries_id: row.timeseries_id,
        observed_at: row.observed_at,
        value: row.value,
      });
      if (parquetRowsBuffer.length >= OBS_R2_PART_MAX_ROWS) {
        await flushPart();
      }
    }

    const last = pageRows[pageRows.length - 1];
    const nextCursor: ObsHistorySourceCursor = {
      after_timeseries_id: last.timeseries_id,
      after_observed_at: last.observed_at,
    };
    const cursorUnchanged = nextCursor.after_timeseries_id === cursor.after_timeseries_id &&
      nextCursor.after_observed_at === cursor.after_observed_at;
    if (cursorUnchanged) {
      throw new Error(
        `obs_aqi_to_r2 observations pagination cursor did not advance for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }
    cursor = nextCursor;
  }

  await flushPart();

  const manifestKey = buildObsConnectorManifestKey(args.day_utc, args.connector_id);
  const connectorManifest = createObsConnectorManifest({
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey,
    sourceRowCount: rowsRead,
    minObservedAt,
    maxObservedAt,
    fileEntries,
    writerGitSha: OBS_R2_WRITER_GIT_SHA,
    backedUpAtUtc: nowIso(),
  });

  await r2PutObject({
    r2: OBS_R2_CONFIG,
    key: manifestKey,
    body: encodeJsonBody(connectorManifest),
    content_type: "application/json",
  });
  const manifestHead = await r2HeadObject({ r2: OBS_R2_CONFIG, key: manifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Missing connector manifest after upload: ${manifestKey}`);
  }

  return {
    rows_read: rowsRead,
    objects_written_r2: fileEntries.length + 1,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest,
  };
}

async function loadExistingAqiConnectorManifest(
  dayUtc: string,
  connectorId: number,
): Promise<AqilevelsConnectorManifest | null> {
  const key = buildAqiConnectorManifestKey(dayUtc, connectorId);
  const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
  if (!head.exists) {
    return null;
  }
  const object = await r2GetObject({ r2: OBS_R2_CONFIG, key });
  let parsed: unknown;
  try {
    parsed = JSON.parse(object.body.toString("utf8"));
  } catch {
    throw new Error(`Invalid existing AQI connector manifest JSON: ${key}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing AQI connector manifest is not an object: ${key}`);
  }
  const record = parsed as Record<string, unknown>;
  const filesRaw = Array.isArray(record.files) ? record.files : [];
  const files: ObsHistoryFileEntry[] = filesRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const item = entry as Record<string, unknown>;
      const fileKey = String(item.key || "").trim();
      if (!fileKey) {
        return null;
      }
      return {
        key: fileKey,
        row_count: toSafeInt(item.row_count),
        bytes: toSafeInt(item.bytes),
        etag_or_hash: item.etag_or_hash === null || item.etag_or_hash === undefined
          ? null
          : String(item.etag_or_hash),
      };
    })
    .filter((value): value is ObsHistoryFileEntry => value !== null);

  return {
    day_utc: parseOptionalDay(record.day_utc) || dayUtc,
    connector_id: Number(record.connector_id) || connectorId,
    run_id: String(record.run_id || ""),
    manifest_key: String(record.manifest_key || key).trim() || key,
    source_row_count: toSafeInt(record.source_row_count),
    min_timestamp_hour_utc: typeof record.min_timestamp_hour_utc === "string"
      ? record.min_timestamp_hour_utc
      : null,
    max_timestamp_hour_utc: typeof record.max_timestamp_hour_utc === "string"
      ? record.max_timestamp_hour_utc
      : null,
    parquet_object_keys: Array.isArray(record.parquet_object_keys)
      ? record.parquet_object_keys.map((value) => String(value || "").trim()).filter(Boolean)
      : files.map((file) => file.key),
    file_count: toSafeInt(record.file_count) || files.length,
    total_bytes: toSafeInt(record.total_bytes) || files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

async function exportAqiConnectorDayToR2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  manifest_key: string;
  connector_manifest: AqilevelsConnectorManifest & Record<string, unknown>;
}> {
  if (FORCE_REPLACE) {
    await deleteR2Prefix(buildAqiConnectorPrefix(args.day_utc, args.connector_id));
  }

  const parquetRowsBuffer: AqilevelsHistoryParquetRow[] = [];
  const fileEntries: ObsHistoryFileEntry[] = [];
  let rowsRead = 0;
  let partIndex = 0;
  let pageCount = 0;
  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;
  let cursor: AqilevelsHistorySourceCursor = {
    after_station_id: null,
    after_timestamp_hour_utc: null,
  };

  const flushPart = async (): Promise<void> => {
    if (!parquetRowsBuffer.length) {
      return;
    }
    const partRows = parquetRowsBuffer.splice(0, parquetRowsBuffer.length);
    const partKey = buildAqiPartKey(args.day_utc, args.connector_id, partIndex);
    const parquetBuffer = rowsToAqiParquetBuffer(partRows);
    const putResult = await r2PutObject({
      r2: OBS_R2_CONFIG,
      key: partKey,
      body: parquetBuffer,
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing AQI parquet part after upload: ${partKey}`);
    }
    fileEntries.push({
      key: partKey,
      row_count: partRows.length,
      bytes: typeof head.bytes === "number" && Number.isFinite(head.bytes)
        ? Math.trunc(head.bytes)
        : Math.trunc(putResult.bytes),
      etag_or_hash: head.etag || putResult.etag || null,
    });
    partIndex += 1;
  };

  while (true) {
    pageCount += 1;
    if (pageCount > OBS_R2_SOURCE_MAX_PAGES) {
      throw new Error(
        `obs_aqi_to_r2 AQI export exceeded max pages (${OBS_R2_SOURCE_MAX_PAGES}) for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }

    const pageRows = await fetchAqilevelsHistoryRowsPage(
      args.day_utc,
      args.connector_id,
      cursor,
      OBS_R2_SOURCE_PAGE_SIZE,
    );
    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      rowsRead += 1;
      if (!minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (!maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }
      parquetRowsBuffer.push({
        connector_id: args.connector_id,
        station_id: row.station_id,
        timestamp_hour_utc: row.timestamp_hour_utc,
        no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
        pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
        pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
        pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
        pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
        no2_hourly_sample_count: row.no2_hourly_sample_count,
        pm25_hourly_sample_count: row.pm25_hourly_sample_count,
        pm10_hourly_sample_count: row.pm10_hourly_sample_count,
        daqi_no2_index_level: row.daqi_no2_index_level,
        daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level,
        daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level,
        eaqi_no2_index_level: row.eaqi_no2_index_level,
        eaqi_pm25_index_level: row.eaqi_pm25_index_level,
        eaqi_pm10_index_level: row.eaqi_pm10_index_level,
      });
      if (parquetRowsBuffer.length >= OBS_R2_PART_MAX_ROWS) {
        await flushPart();
      }
    }

    const last = pageRows[pageRows.length - 1];
    const nextCursor: AqilevelsHistorySourceCursor = {
      after_station_id: last.station_id,
      after_timestamp_hour_utc: last.timestamp_hour_utc,
    };
    const cursorUnchanged = nextCursor.after_station_id === cursor.after_station_id &&
      nextCursor.after_timestamp_hour_utc === cursor.after_timestamp_hour_utc;
    if (cursorUnchanged) {
      throw new Error(
        `obs_aqi_to_r2 AQI pagination cursor did not advance for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }
    cursor = nextCursor;
  }

  await flushPart();

  const manifestKey = buildAqiConnectorManifestKey(args.day_utc, args.connector_id);
  const connectorManifest = createAqiConnectorManifest({
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey,
    sourceRowCount: rowsRead,
    minTimestampHourUtc,
    maxTimestampHourUtc,
    fileEntries,
    writerGitSha: OBS_R2_WRITER_GIT_SHA,
    backedUpAtUtc: nowIso(),
  });

  await r2PutObject({
    r2: OBS_R2_CONFIG,
    key: manifestKey,
    body: encodeJsonBody(connectorManifest),
    content_type: "application/json",
  });
  const manifestHead = await r2HeadObject({ r2: OBS_R2_CONFIG, key: manifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Missing AQI connector manifest after upload: ${manifestKey}`);
  }

  return {
    rows_read: rowsRead,
    objects_written_r2: fileEntries.length + 1,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest,
  };
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

async function upsertAqilevelsRows(
  helperRows: HelperRow[],
  dayStartIso: string,
  dayEndIso: string,
): Promise<{ rowsWritten: number; dailyRows: number; monthlyRows: number }> {
  const aqilevelsUrl = requiredEnv("OBS_AQIDB_SUPABASE_URL");
  const aqilevelsKey = requiredEnv("OBS_AQIDB_SECRET_KEY");

  if (helperRows.length === 0) {
    return { rowsWritten: 0, dailyRows: 0, monthlyRows: 0 };
  }

  const aqilevelsSource: SourceDbConfig = {
    kind: "ingestdb",
    base_url: aqilevelsUrl,
    privileged_key: aqilevelsKey,
  };

  let rowsWritten = 0;
  let stationHoursChanged = 0;

  const referenceHour = addUtcHours(dayEndIso, -1);
  const lateCutoffHour = addUtcHours(referenceHour, -36);

  for (const chunk of chunkRows(helperRows, HOURLY_UPSERT_CHUNK_SIZE)) {
    const result = await postgrestRpc<unknown>(aqilevelsSource, HOURLY_UPSERT_RPC, {
      p_rows: chunk,
      p_late_cutoff_hour: lateCutoffHour,
      p_reference_hour: referenceHour,
    });
    if (result.error) {
      throw new Error(`AQI levels hourly upsert RPC failed: ${result.error.message}`);
    }

    const metrics = parseHourlyUpsertMetrics(result.data);
    rowsWritten += metrics.rows_changed;
    stationHoursChanged += metrics.station_hours_changed;
  }

  const stationIds = Array.from(new Set(helperRows.map((row) => row.station_id))).sort((l, r) => l - r);
  const rollupResult = await postgrestRpc<unknown>(aqilevelsSource, ROLLUP_REFRESH_RPC, {
    p_start_hour_utc: dayStartIso,
    p_end_hour_utc: dayEndIso,
    p_station_ids: stationIds,
  });
  if (rollupResult.error) {
    throw new Error(`AQI levels rollup refresh RPC failed: ${rollupResult.error.message}`);
  }

  const rollupMetrics = parseRollupMetrics(rollupResult.data);

  logStructured("info", "local_to_aqilevels_chunk_summary", {
    rows_written_aqilevels: rowsWritten,
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
  if (!(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return false;
  }
  if (DRY_RUN && !DRY_RUN_WRITE_LEDGER) {
    return false;
  }

  const query = new URLSearchParams();
  query.set("select", "run_id");
  query.set("limit", "1");

  const result = await postgrestTable<unknown[]>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
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
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return;
  }

  const query = new URLSearchParams();
  query.set("run_id", `eq.${runId}`);

  const result = await postgrestTable<unknown>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return null;
  }

  const query = new URLSearchParams();
  query.set("select", "status");
  query.set("run_mode", `eq.${RUN_MODE}`);
  query.set("day_utc", `eq.${dayUtc}`);
  query.set("connector_id", `eq.${connectorId}`);
  query.set("limit", "1");

  const result = await postgrestTable<Array<Record<string, unknown>>>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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
  if (!ledgerEnabled || !(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    return;
  }

  const result = await postgrestTable<unknown>(
    OBS_AQIDB_SUPABASE_URL,
    OBS_AQI_PRIVILEGED_KEY,
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

async function runLocalToAqilevels(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
  dayListOverride: string[] | null = null,
): Promise<LocalToAqilevelsSummary> {
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    throw new Error("local_to_aqilevels requires SUPABASE_URL + SB_SECRET_KEY");
  }
  if (!(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    throw new Error("local_to_aqilevels requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }

  const days = dayListOverride && dayListOverride.length > 0
    ? [...dayListOverride]
    : buildBackwardDayRange(window.from_day_utc, window.to_day_utc);
  const summary: LocalToAqilevelsSummary = {
    mode: "local_to_aqilevels",
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
    rows_written_aqilevels: 0,
    rollup_daily_rows_upserted: 0,
    rollup_monthly_rows_upserted: 0,
    day_connector_results: [],
  };

  for (const dayUtc of days) {
    const dayStartIso = utcDayStartIso(dayUtc);
    const dayEndIso = utcDayEndIso(dayUtc);

    logStructured("info", "local_to_aqilevels_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: CONNECTOR_IDS,
      ingest_retention_days: INGEST_RETENTION_DAYS,
    });

    const ingestCounts = await fetchConnectorCountsForDay("ingestdb", dayStartIso, dayEndIso);
    const observsCounts = await fetchConnectorCountsForDay("obs_aqidb", dayStartIso, dayEndIso);

    const connectors = CONNECTOR_IDS || connectorListFromCounts(ingestCounts, observsCounts);

    if (!connectors.length) {
      logStructured("warning", "local_to_aqilevels_day_no_connectors", {
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
        const noSourceResult: LocalToAqilevelsDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "skipped",
          skip_reason: "no_source_rows",
          rows_read: 0,
          rows_written_aqilevels: 0,
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
          rows_written_aqilevels: 0,
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
        const skippedResult: LocalToAqilevelsDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "skipped",
          skip_reason: skipDecision.reason,
          rows_read: 0,
          rows_written_aqilevels: 0,
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
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          checkpoint_json: { skip_reason: skipDecision.reason },
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        continue;
      }

      const startedAt = nowIso();

      if (sourceKind === "r2") {
        const result: LocalToAqilevelsDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "error",
          skip_reason: null,
          rows_read: 0,
          rows_written_aqilevels: 0,
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
          rows_written_aqilevels: 0,
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
          logStructured("info", "local_to_aqilevels_dry_run_plan", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: sourceKind,
            source_filter: sourceFetch.source_filter,
            rows_read: normalized.rowsRead,
            rows_candidate_aqilevels: normalized.helperRows.length,
          });
        } else {
          const writeSummary = await upsertAqilevelsRows(
            normalized.helperRows,
            dayStartIso,
            dayEndIso,
          );
          rowsWritten = writeSummary.rowsWritten;
          dailyRows = writeSummary.dailyRows;
          monthlyRows = writeSummary.monthlyRows;
        }

        const status: LocalToAqilevelsDayConnectorResult["status"] = DRY_RUN ? "dry_run" : "complete";
        const result: LocalToAqilevelsDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status,
          skip_reason: null,
          rows_read: normalized.rowsRead,
          rows_written_aqilevels: rowsWritten,
          daily_rows_upserted: dailyRows,
          monthly_rows_upserted: monthlyRows,
          error: null,
        };

        summary.rows_read += normalized.rowsRead;
        summary.rows_written_aqilevels += rowsWritten;
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
          rows_written_aqilevels: rowsWritten,
          objects_written_r2: 0,
          checkpoint_json: {
            source_filter: sourceFetch.source_filter,
            rows_candidate_aqilevels: normalized.helperRows.length,
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
            rows_written_aqilevels: rowsWritten,
            objects_written_r2: 0,
            checkpoint_json: {
              updated_by_run_id: runId,
              source_filter: sourceFetch.source_filter,
              completed_at: nowIso(),
            },
            updated_at: nowIso(),
          });
        }

        logStructured("info", "local_to_aqilevels_day_connector_done", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status,
          rows_read: normalized.rowsRead,
          rows_written_aqilevels: rowsWritten,
          daily_rows_upserted: dailyRows,
          monthly_rows_upserted: monthlyRows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: LocalToAqilevelsDayConnectorResult = {
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: sourceKind,
          status: "error",
          skip_reason: null,
          rows_read: 0,
          rows_written_aqilevels: 0,
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
          rows_written_aqilevels: 0,
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
          rows_written_aqilevels: 0,
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

        logStructured("error", "local_to_aqilevels_day_connector_failed", {
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

function deriveWindowFromDayList(dayUtcList: string[]): { from_day_utc: string; to_day_utc: string } {
  if (dayUtcList.length === 0) {
    throw new Error("dayUtcList must not be empty");
  }
  const sorted = [...dayUtcList].sort(compareIsoDay);
  return {
    from_day_utc: sorted[0],
    to_day_utc: sorted[sorted.length - 1],
  };
}

async function runObservsToR2(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
): Promise<ObsAqiToR2Summary> {
  if (!(OBS_AQIDB_SUPABASE_URL && OBS_AQI_PRIVILEGED_KEY)) {
    throw new Error("obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY");
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error("obs_aqi_to_r2 requires CFLARE_R2_* or R2_* credentials.");
  }

  const requestedDays = buildBackwardDayRange(window.from_day_utc, window.to_day_utc);
  const initialObservsBackedUpDaySet = await fetchR2BackedUpDaySet(requestedDays, {
    day_manifest_prefix: OBS_R2_HISTORY_PREFIX,
  });
  const initialAqilevelsBackedUpDaySet = await fetchR2BackedUpDaySet(requestedDays, {
    day_manifest_prefix: AQI_R2_HISTORY_PREFIX,
  });
  const initialBackedUpDays = requestedDays.filter((dayUtc) =>
    initialObservsBackedUpDaySet.has(dayUtc) && initialAqilevelsBackedUpDaySet.has(dayUtc)
  );
  const observsExecutionDays = FORCE_REPLACE
    ? [...requestedDays]
    : requestedDays.filter((dayUtc) => !initialObservsBackedUpDaySet.has(dayUtc));
  const aqilevelsExecutionDays = FORCE_REPLACE
    ? [...requestedDays]
    : requestedDays.filter((dayUtc) => !initialAqilevelsBackedUpDaySet.has(dayUtc));
  const pendingExecutionDaySet = new Set<string>([
    ...observsExecutionDays,
    ...aqilevelsExecutionDays,
  ]);
  const executionDays = requestedDays.filter((dayUtc) => pendingExecutionDaySet.has(dayUtc));

  const initialBackedUpSorted = [...initialBackedUpDays].sort(compareIsoDay);
  const summary: ObsAqiToR2Summary = {
    mode: "obs_aqi_to_r2",
    run_id: runId,
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: requestedDays.length,
    days_processed: 0,
    connector_day_complete: 0,
    connector_day_skipped: 0,
    connector_day_error: 0,
    rows_read: 0,
    objects_written_r2: 0,
    backed_up_days: initialBackedUpDays,
    pending_backfill_days: executionDays,
    exported_days: [],
    failed_days: [],
    day_connector_results: [],
    min_day_utc: initialBackedUpSorted.length ? initialBackedUpSorted[0] : null,
    max_day_utc: initialBackedUpSorted.length
      ? initialBackedUpSorted[initialBackedUpSorted.length - 1]
      : null,
    message: executionDays.length > 0
      ? "Planned pending day exports for observations + aqilevels history manifests."
      : "All requested days already have observations + aqilevels day manifests in R2.",
  };

  if (DRY_RUN) {
    return summary;
  }

  const processedDays = new Set<string>();

  for (const dayUtc of observsExecutionDays) {
    processedDays.add(dayUtc);
    const dayStartIso = utcDayStartIso(dayUtc);
    const dayEndIso = utcDayEndIso(dayUtc);

    logStructured("info", "obs_aqi_to_r2_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: CONNECTOR_IDS,
      force_replace: FORCE_REPLACE,
    });

    const connectorCounts = await fetchConnectorCountsForDay("obs_aqidb", dayStartIso, dayEndIso);
    const allSourceConnectors = Array.from(connectorCounts.entries())
      .filter((entry) => entry[1] > 0)
      .map((entry) => entry[0])
      .sort((left, right) => left - right);
    const targetConnectors = (CONNECTOR_IDS || allSourceConnectors).slice().sort((left, right) => left - right);
    const targetSet = new Set(targetConnectors);
    const manifestsByConnector = new Map<number, ObsConnectorManifest & Record<string, unknown>>();
    let dayFailed = false;

    for (const connectorId of targetConnectors) {
      const startedAt = nowIso();
      const expectedRows = connectorCounts.get(connectorId) || 0;
      if (expectedRows <= 0) {
        summary.connector_day_skipped += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "skipped",
          skip_reason: "no_source_rows",
          rows_read: 0,
          objects_written_r2: 0,
          manifest_key: null,
          error: null,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "skipped",
          rows_read: 0,
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          checkpoint_json: { skip_reason: "no_source_rows" },
          started_at: startedAt,
          finished_at: nowIso(),
        });
        continue;
      }

      try {
        const exportResult = await exportObsConnectorDayToR2({
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
        });
        if (expectedRows > 0 && exportResult.rows_read <= 0) {
          throw new Error(
            `obs_aqi_to_r2 expected rows for connector=${connectorId} day=${dayUtc} but export returned 0 rows`,
          );
        }
        if (expectedRows > 0 && exportResult.rows_read !== expectedRows) {
          logStructured("warning", "obs_aqi_to_r2_connector_row_mismatch", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            expected_rows: expectedRows,
            exported_rows: exportResult.rows_read,
          });
        }
        manifestsByConnector.set(connectorId, exportResult.connector_manifest);

        summary.connector_day_complete += 1;
        summary.rows_read += exportResult.rows_read;
        summary.objects_written_r2 += exportResult.objects_written_r2;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "complete",
          skip_reason: null,
          rows_read: exportResult.rows_read,
          objects_written_r2: exportResult.objects_written_r2,
          manifest_key: exportResult.manifest_key,
          error: null,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "complete",
          rows_read: exportResult.rows_read,
          rows_written_aqilevels: 0,
          objects_written_r2: exportResult.objects_written_r2,
          checkpoint_json: {
            manifest_key: exportResult.manifest_key,
          },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "complete",
          rows_read: exportResult.rows_read,
          rows_written_aqilevels: 0,
          objects_written_r2: exportResult.objects_written_r2,
          checkpoint_json: {
            updated_by_run_id: runId,
            manifest_key: exportResult.manifest_key,
            completed_at: nowIso(),
          },
          updated_at: nowIso(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dayFailed = true;
        summary.connector_day_error += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "error",
          skip_reason: null,
          rows_read: 0,
          objects_written_r2: 0,
          manifest_key: null,
          error: message,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "error",
          rows_read: 0,
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          error_json: { message },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "error",
          rows_read: 0,
          rows_written_aqilevels: 0,
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
          source_kind: "obs_aqidb",
          error_json: { message },
          started_at: startedAt,
          finished_at: nowIso(),
        });
      }
    }

    for (const connectorId of allSourceConnectors) {
      if (targetSet.has(connectorId)) {
        continue;
      }
      if (manifestsByConnector.has(connectorId)) {
        continue;
      }
      const existing = await loadExistingConnectorManifest(dayUtc, connectorId);
      if (existing) {
        manifestsByConnector.set(connectorId, existing);
      } else {
        dayFailed = true;
      }
    }

    if (allSourceConnectors.length === 0) {
      dayFailed = true;
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "obs_aqidb",
        error_json: { message: "no_source_rows_for_day" },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
      logStructured("warning", "obs_aqi_to_r2_day_no_source_rows", {
        run_id: runId,
        day_utc: dayUtc,
      });
    }

    const unresolvedConnectors = allSourceConnectors.filter((connectorId) =>
      !manifestsByConnector.has(connectorId)
    );
    if (unresolvedConnectors.length > 0) {
      dayFailed = true;
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "r2",
        error_json: { message: "day_manifest_blocked_missing_connector_manifests", missing_connectors: unresolvedConnectors },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
    }

    if (!dayFailed) {
      const connectorManifests = Array.from(manifestsByConnector.values()).sort((left, right) =>
        Number(left.connector_id) - Number(right.connector_id)
      );
      const dayManifest = createObsDayManifest({
        dayUtc,
        runId,
        connectorManifests,
        writerGitSha: OBS_R2_WRITER_GIT_SHA,
        backedUpAtUtc: nowIso(),
      });
      const dayManifestKey = buildObsDayManifestKey(dayUtc);
      await r2PutObject({
        r2: OBS_R2_CONFIG,
        key: dayManifestKey,
        body: encodeJsonBody(dayManifest),
        content_type: "application/json",
      });
      const manifestHead = await r2HeadObject({ r2: OBS_R2_CONFIG, key: dayManifestKey });
      if (!manifestHead.exists) {
        throw new Error(`Missing day manifest after upload: ${dayManifestKey}`);
      }
      summary.objects_written_r2 += 1;
      summary.exported_days.push(dayUtc);
      logStructured("info", "obs_aqi_to_r2_day_complete", {
        run_id: runId,
        day_utc: dayUtc,
        connector_count: connectorManifests.length,
        day_manifest_key: dayManifestKey,
      });
    } else {
      summary.failed_days.push(dayUtc);
      logStructured("warning", "obs_aqi_to_r2_day_failed", {
        run_id: runId,
        day_utc: dayUtc,
        unresolved_connectors: unresolvedConnectors,
      });
    }

  }

  for (const dayUtc of aqilevelsExecutionDays) {
    processedDays.add(dayUtc);
    const connectorCounts = await fetchAqilevelsConnectorCountsForDay(dayUtc);
    const allSourceConnectors = Array.from(connectorCounts.entries())
      .filter((entry) => entry[1] > 0)
      .map((entry) => entry[0])
      .sort((left, right) => left - right);
    const targetConnectors = (CONNECTOR_IDS || allSourceConnectors).slice().sort((left, right) => left - right);
    const targetSet = new Set(targetConnectors);
    const manifestsByConnector = new Map<number, AqilevelsConnectorManifest & Record<string, unknown>>();
    let dayFailed = false;

    logStructured("info", "obs_aqi_to_r2_aqilevels_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: CONNECTOR_IDS,
      force_replace: FORCE_REPLACE,
    });

    for (const connectorId of targetConnectors) {
      const startedAt = nowIso();
      const expectedRows = connectorCounts.get(connectorId) || 0;
      if (expectedRows <= 0) {
        summary.connector_day_skipped += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "skipped",
          skip_reason: "no_source_rows",
          rows_read: 0,
          objects_written_r2: 0,
          manifest_key: null,
          error: null,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "skipped",
          rows_read: 0,
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          checkpoint_json: { skip_reason: "no_source_rows", domain: "aqilevels" },
          started_at: startedAt,
          finished_at: nowIso(),
        });
        continue;
      }

      try {
        const exportResult = await exportAqiConnectorDayToR2({
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
        });
        if (expectedRows > 0 && exportResult.rows_read <= 0) {
          throw new Error(
            `obs_aqi_to_r2 expected AQI rows for connector=${connectorId} day=${dayUtc} but export returned 0 rows`,
          );
        }
        if (expectedRows > 0 && exportResult.rows_read !== expectedRows) {
          logStructured("warning", "obs_aqi_to_r2_aqilevels_connector_row_mismatch", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            expected_rows: expectedRows,
            exported_rows: exportResult.rows_read,
          });
        }
        manifestsByConnector.set(connectorId, exportResult.connector_manifest);

        summary.connector_day_complete += 1;
        summary.rows_read += exportResult.rows_read;
        summary.objects_written_r2 += exportResult.objects_written_r2;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "complete",
          skip_reason: null,
          rows_read: exportResult.rows_read,
          objects_written_r2: exportResult.objects_written_r2,
          manifest_key: exportResult.manifest_key,
          error: null,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "complete",
          rows_read: exportResult.rows_read,
          rows_written_aqilevels: 0,
          objects_written_r2: exportResult.objects_written_r2,
          checkpoint_json: {
            domain: "aqilevels",
            manifest_key: exportResult.manifest_key,
          },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "complete",
          rows_read: exportResult.rows_read,
          rows_written_aqilevels: 0,
          objects_written_r2: exportResult.objects_written_r2,
          checkpoint_json: {
            updated_by_run_id: runId,
            domain: "aqilevels",
            manifest_key: exportResult.manifest_key,
            completed_at: nowIso(),
          },
          updated_at: nowIso(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dayFailed = true;
        summary.connector_day_error += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "error",
          skip_reason: null,
          rows_read: 0,
          objects_written_r2: 0,
          manifest_key: null,
          error: message,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "error",
          rows_read: 0,
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          error_json: { message, domain: "aqilevels" },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "obs_aqidb",
          status: "error",
          rows_read: 0,
          rows_written_aqilevels: 0,
          objects_written_r2: 0,
          checkpoint_json: {
            updated_by_run_id: runId,
            domain: "aqilevels",
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
          source_kind: "obs_aqidb",
          error_json: { message, domain: "aqilevels" },
          started_at: startedAt,
          finished_at: nowIso(),
        });
      }
    }

    for (const connectorId of allSourceConnectors) {
      if (targetSet.has(connectorId)) {
        continue;
      }
      if (manifestsByConnector.has(connectorId)) {
        continue;
      }
      const existing = await loadExistingAqiConnectorManifest(dayUtc, connectorId);
      if (existing) {
        manifestsByConnector.set(connectorId, existing);
      } else {
        dayFailed = true;
      }
    }

    if (allSourceConnectors.length === 0) {
      dayFailed = true;
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "obs_aqidb",
        error_json: { message: "no_aqilevels_source_rows_for_day" },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
      logStructured("warning", "obs_aqi_to_r2_aqilevels_day_no_source_rows", {
        run_id: runId,
        day_utc: dayUtc,
      });
    }

    const unresolvedConnectors = allSourceConnectors.filter((connectorId) =>
      !manifestsByConnector.has(connectorId)
    );
    if (unresolvedConnectors.length > 0) {
      dayFailed = true;
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "r2",
        error_json: {
          message: "aqilevels_day_manifest_blocked_missing_connector_manifests",
          missing_connectors: unresolvedConnectors,
        },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
    }

    if (!dayFailed) {
      const connectorManifests = Array.from(manifestsByConnector.values()).sort((left, right) =>
        Number(left.connector_id) - Number(right.connector_id)
      );
      const dayManifest = createAqiDayManifest({
        dayUtc,
        runId,
        connectorManifests,
        writerGitSha: OBS_R2_WRITER_GIT_SHA,
        backedUpAtUtc: nowIso(),
      });
      const dayManifestKey = buildAqiDayManifestKey(dayUtc);
      await r2PutObject({
        r2: OBS_R2_CONFIG,
        key: dayManifestKey,
        body: encodeJsonBody(dayManifest),
        content_type: "application/json",
      });
      const manifestHead = await r2HeadObject({ r2: OBS_R2_CONFIG, key: dayManifestKey });
      if (!manifestHead.exists) {
        throw new Error(`Missing AQI day manifest after upload: ${dayManifestKey}`);
      }
      summary.objects_written_r2 += 1;
      summary.exported_days.push(dayUtc);
      logStructured("info", "obs_aqi_to_r2_aqilevels_day_complete", {
        run_id: runId,
        day_utc: dayUtc,
        connector_count: connectorManifests.length,
        day_manifest_key: dayManifestKey,
      });
    } else {
      summary.failed_days.push(dayUtc);
      logStructured("warning", "obs_aqi_to_r2_aqilevels_day_failed", {
        run_id: runId,
        day_utc: dayUtc,
        unresolved_connectors: unresolvedConnectors,
      });
    }
  }

  const failedDaySet = new Set(summary.failed_days);
  summary.failed_days = Array.from(failedDaySet).sort(compareIsoDay);
  summary.exported_days = Array.from(new Set(summary.exported_days))
    .filter((dayUtc) => !failedDaySet.has(dayUtc))
    .sort(compareIsoDay);
  summary.days_processed = processedDays.size;

  const finalObservsBackedUpDaySet = await fetchR2BackedUpDaySet(requestedDays, {
    day_manifest_prefix: OBS_R2_HISTORY_PREFIX,
  });
  const finalAqilevelsBackedUpDaySet = await fetchR2BackedUpDaySet(requestedDays, {
    day_manifest_prefix: AQI_R2_HISTORY_PREFIX,
  });
  summary.backed_up_days = requestedDays.filter((dayUtc) =>
    finalObservsBackedUpDaySet.has(dayUtc) && finalAqilevelsBackedUpDaySet.has(dayUtc)
  );
  summary.pending_backfill_days = requestedDays.filter((dayUtc) =>
    !(finalObservsBackedUpDaySet.has(dayUtc) && finalAqilevelsBackedUpDaySet.has(dayUtc))
  );
  const backedUpSorted = [...summary.backed_up_days].sort(compareIsoDay);
  summary.min_day_utc = backedUpSorted.length ? backedUpSorted[0] : null;
  summary.max_day_utc = backedUpSorted.length ? backedUpSorted[backedUpSorted.length - 1] : null;
  if (summary.pending_backfill_days.length > 0) {
    summary.message = `obs_aqi_to_r2 completed with ${summary.pending_backfill_days.length} pending day(s).`;
  } else if (observsExecutionDays.length === 0 && aqilevelsExecutionDays.length === 0) {
    summary.message = "All requested days already had committed observations + aqilevels day manifests in R2.";
  } else {
    summary.message = "obs_aqi_to_r2 completed and all requested days now have committed observations + aqilevels day manifests in R2.";
  }

  return summary;
}

async function runSourceToAll(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
): Promise<SourceToAllSummary> {
  const retentionWindow = computeRollingLocalRetentionWindow({
    nowUtc: new Date(),
    timeZone: LOCAL_TIMEZONE,
    localRetentionDays: OBS_AQI_LOCAL_RETENTION_DAYS,
  });

  const days = buildBackwardDayRange(window.from_day_utc, window.to_day_utc);
  const localToAqilevelsDays: string[] = [];
  const sourceAcquisitionPendingDays: string[] = [];

  for (const dayUtc of days) {
    if (isDayInRollingRetentionWindow(dayUtc, retentionWindow)) {
      localToAqilevelsDays.push(dayUtc);
    } else {
      sourceAcquisitionPendingDays.push(dayUtc);
    }
  }

  let localSummary: LocalToAqilevelsSummary | null = null;
  if (localToAqilevelsDays.length > 0) {
    const localWindow = deriveWindowFromDayList(localToAqilevelsDays);
    localSummary = await runLocalToAqilevels(
      runId,
      localWindow,
      ledgerEnabled,
      localToAqilevelsDays,
    );
  }

  const warnings: string[] = [];
  if (sourceAcquisitionPendingDays.length > 0) {
    warnings.push(
      "External source acquisition for non-local days is pending Phase 9 implementation; those days were not written.",
    );
  }

  return {
    mode: "source_to_all",
    run_id: runId,
    dry_run: DRY_RUN,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: days.length,
    rows_read: localSummary?.rows_read || 0,
    rows_written_aqilevels: localSummary?.rows_written_aqilevels || 0,
    retention_window: retentionWindow,
    local_to_aqilevels_days: localToAqilevelsDays,
    source_acquisition_pending_days: sourceAcquisitionPendingDays,
    local_to_aqilevels_summary: localSummary,
    warnings,
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
    allow_stub_modes: ALLOW_STUB_MODES,
    ledger_enabled: ledgerEnabled,
  });

  let summary: RunSummary;
  let runStatus: RunStatus = DRY_RUN ? "dry_run" : "ok";
  let errorMessage: string | null = null;

  try {
    if (RUN_MODE === "local_to_aqilevels") {
      summary = await runLocalToAqilevels(runId, window, ledgerEnabled);
      if (summary.connector_day_error > 0) {
        runStatus = "error";
        errorMessage = `local_to_aqilevels encountered ${summary.connector_day_error} connector-day errors`;
      }
    } else if (RUN_MODE === "obs_aqi_to_r2") {
      summary = await runObservsToR2(runId, window, ledgerEnabled);
      if (summary.connector_day_error > 0 || (!DRY_RUN && summary.pending_backfill_days.length > 0)) {
        runStatus = "error";
        errorMessage =
          `obs_aqi_to_r2 encountered ${summary.connector_day_error} connector-day errors and has ${summary.pending_backfill_days.length} pending day(s)`;
      } else {
        runStatus = DRY_RUN ? "dry_run" : "ok";
      }
    } else {
      summary = await runSourceToAll(runId, window, ledgerEnabled);
      const localErrors = summary.local_to_aqilevels_summary?.connector_day_error || 0;
      if (localErrors > 0) {
        runStatus = "error";
        errorMessage = `source_to_all local_to_aqilevels encountered ${localErrors} connector-day errors`;
      } else if (!DRY_RUN && summary.source_acquisition_pending_days.length > 0) {
        runStatus = "stubbed";
      } else {
        runStatus = DRY_RUN ? "dry_run" : "ok";
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runStatus = "error";
    errorMessage = message;
    summary = {
      mode: RUN_MODE,
      run_id: runId,
      failed: true,
      message: "run_failed",
      from_day_utc: window.from_day_utc,
      to_day_utc: window.to_day_utc,
      days_planned: dayRangeDaysCount(window.from_day_utc, window.to_day_utc),
    };

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
    rows_written_aqilevels: "rows_written_aqilevels" in summary ? summary.rows_written_aqilevels : 0,
    objects_written_r2: "objects_written_r2" in summary ? summary.objects_written_r2 : 0,
    checkpoint_json: {
      summary,
      connector_ids: CONNECTOR_IDS,
      enable_r2_fallback: ENABLE_R2_FALLBACK,
      allow_stub_modes: ALLOW_STUB_MODES,
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
