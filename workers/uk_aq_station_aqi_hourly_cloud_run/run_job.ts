type RpcError = { message: string };

type RpcResult<T> = {
  data: T | null;
  error: RpcError | null;
};

type RunMode = "sync_hourly" | "backfill" | "reconcile_short" | "reconcile_deep";

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

type HelperRefreshMetrics = {
  source_rows: number;
  rows_upserted: number;
  station_hours_changed: number;
  max_changed_lag_hours: number | null;
};

type FilteredHelperRows = {
  rows: HelperRow[];
  missingStationIds: number[];
  skippedRowCount: number;
};

type SyncWindow = {
  hourEndStartExclusive: Date;
  hourEndEndInclusive: Date;
  referenceHourEnd: Date;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const HELPER_WINDOW_RPC_PAGE_SIZE = 1000;
const OBS_STATION_LOOKUP_CHUNK_SIZE = 200;

const INGEST_SUPABASE_URL = requiredEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = requiredEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = requiredEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQI_PRIVILEGED_KEY = requiredEnv("OBS_AQIDB_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public").trim();
const HELPER_UPSERT_RPC = "uk_aq_rpc_station_aqi_hourly_helper_upsert";
const HELPER_WINDOW_RPC = (Deno.env.get("UK_AQ_AQI_HELPER_WINDOW_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_helper_window").trim();
const HOURLY_UPSERT_RPC = (Deno.env.get("UK_AQ_AQI_HOURLY_UPSERT_RPC") ||
  "uk_aq_rpc_station_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC = (Deno.env.get("UK_AQ_AQI_ROLLUP_REFRESH_RPC") ||
  "uk_aq_rpc_station_aqi_rollups_refresh").trim();
const RUN_LOG_RPC = (Deno.env.get("UK_AQ_AQI_RUN_LOG_RPC") ||
  "uk_aq_rpc_aqi_compute_run_log").trim();
const RUN_CLEANUP_RPC = (Deno.env.get("UK_AQ_AQI_RUN_CLEANUP_RPC") ||
  "uk_aq_rpc_aqi_compute_runs_cleanup").trim();

const RUN_MODE = parseRunMode(Deno.env.get("UK_AQ_AQI_RUN_MODE"), "sync_hourly");
const RECONCILE_SHORT_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RECONCILE_SHORT_HOURS"),
  8,
);
const RECONCILE_DEEP_HOURS = parsePositiveInt(
  Deno.env.get("UK_AQ_AQI_RECONCILE_DEEP_HOURS"),
  36,
);
const TRIGGER_MODE = (Deno.env.get("UK_AQ_AQI_TRIGGER_MODE") || "manual").trim() || "manual";
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
const OBS_STATION_LOOKUP_VIEW = (
  Deno.env.get("UK_AQ_AQI_OBS_STATION_LOOKUP_VIEW") || "uk_aq_station_connector_lookup"
).trim();
const FROM_HOUR_UTC = optionalEnv("UK_AQ_AQI_FROM_HOUR_UTC");
const TO_HOUR_UTC = optionalEnv("UK_AQ_AQI_TO_HOUR_UTC");
const STATION_IDS = parseStationIdsCsv(optionalEnv("UK_AQ_AQI_STATION_IDS_CSV"));
const obsStationExistsCache = new Map<number, boolean>();

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
    value === "sync_hourly" ||
    value === "backfill" ||
    value === "reconcile_short" ||
    value === "reconcile_deep"
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
    "x-ukaq-egress-caller": "uk_aq_station_aqi_hourly_cloud_run",
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

function buildRollingWindow(referenceHourEnd: Date, hours: number): SyncWindow {
  return {
    hourEndStartExclusive: addHours(referenceHourEnd, -hours),
    hourEndEndInclusive: referenceHourEnd,
    referenceHourEnd,
  };
}

function runWindow(nowUtc: Date): SyncWindow {
  const totalDelayMs =
    MATURITY_DELAY_HOURS * ONE_HOUR_MS + MATURITY_DELAY_BUFFER_MINUTES * ONE_MINUTE_MS;
  const targetHourEnd = floorUtcHour(new Date(nowUtc.getTime() - totalDelayMs));

  if (RUN_MODE === "backfill") {
    if (!FROM_HOUR_UTC || !TO_HOUR_UTC) {
      throw new Error("Backfill mode requires UK_AQ_AQI_FROM_HOUR_UTC and UK_AQ_AQI_TO_HOUR_UTC");
    }
    const fromHourEnd = parseIsoHour(FROM_HOUR_UTC);
    const toHourEnd = parseIsoHour(TO_HOUR_UTC);
    if (toHourEnd.getTime() < fromHourEnd.getTime()) {
      throw new Error("UK_AQ_AQI_TO_HOUR_UTC must be >= UK_AQ_AQI_FROM_HOUR_UTC");
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
    const stationId = Number(row.station_id);
    const timestampRaw = String(row.timestamp_hour_utc || "").trim();
    if (!Number.isInteger(stationId) || stationId <= 0 || Number.isNaN(Date.parse(timestampRaw))) {
      continue;
    }

    rows.push({
      station_id: Math.trunc(stationId),
      timestamp_hour_utc: hourIso(new Date(Date.parse(timestampRaw))),
      no2_hourly_mean_ugm3: toNullableNumber(row.no2_hourly_mean_ugm3),
      pm25_hourly_mean_ugm3: toNullableNumber(row.pm25_hourly_mean_ugm3),
      pm10_hourly_mean_ugm3: toNullableNumber(row.pm10_hourly_mean_ugm3),
      pm25_rolling24h_mean_ugm3: toNullableNumber(row.pm25_rolling24h_mean_ugm3),
      pm10_rolling24h_mean_ugm3: toNullableNumber(row.pm10_rolling24h_mean_ugm3),
      no2_hourly_sample_count: toNullableInt(row.no2_hourly_sample_count),
      pm25_hourly_sample_count: toNullableInt(row.pm25_hourly_sample_count),
      pm10_hourly_sample_count: toNullableInt(row.pm10_hourly_sample_count),
    });
  }

  rows.sort((a, b) => {
    if (a.timestamp_hour_utc < b.timestamp_hour_utc) return -1;
    if (a.timestamp_hour_utc > b.timestamp_hour_utc) return 1;
    return a.station_id - b.station_id;
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

function parseHelperRefreshMetrics(payload: unknown): HelperRefreshMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("helper upsert RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    source_rows: toSafeInt(row.source_rows),
    rows_upserted: toSafeInt(row.rows_upserted),
    station_hours_changed: toSafeInt(row.station_hours_changed),
    max_changed_lag_hours: toNullableNumber(row.max_changed_lag_hours),
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

async function fetchKnownObsStationIds(stationIds: number[]): Promise<Set<number>> {
  const requestedIds = Array.from(new Set(
    stationIds
      .filter((stationId) => Number.isInteger(stationId) && stationId > 0)
      .map((stationId) => Math.trunc(stationId)),
  ));
  if (requestedIds.length === 0) {
    return new Set<number>();
  }

  const unresolvedIds = requestedIds.filter((stationId) => !obsStationExistsCache.has(stationId));
  for (const chunk of chunkRows(unresolvedIds, OBS_STATION_LOOKUP_CHUNK_SIZE)) {
    const query = new URLSearchParams();
    query.set("select", "station_id");
    query.set("station_id", `in.(${chunk.join(",")})`);
    const url = `${normalizeUrl(OBS_AQIDB_SUPABASE_URL)}/${OBS_STATION_LOOKUP_VIEW}?${query.toString()}`;
    const headers: Record<string, string> = {
      apikey: OBS_AQI_PRIVILEGED_KEY,
      Authorization: `Bearer ${OBS_AQI_PRIVILEGED_KEY}`,
      Accept: "application/json",
      "Accept-Profile": RPC_SCHEMA,
      "x-ukaq-egress-caller": "uk_aq_station_aqi_hourly_cloud_run",
    };

    const response = await fetch(url, {
      method: "GET",
      headers,
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

    if (!response.ok) {
      throw new Error(
        `obs station lookup failed for ${OBS_STATION_LOOKUP_VIEW}: ${asErrorMessage(payload, response.status)}`,
      );
    }

    const foundIds = new Set<number>();
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        const stationId = Number((item as Record<string, unknown>).station_id);
        if (Number.isInteger(stationId) && stationId > 0) {
          foundIds.add(Math.trunc(stationId));
        }
      }
    }

    for (const stationId of chunk) {
      obsStationExistsCache.set(stationId, foundIds.has(stationId));
    }
  }

  const existingIds = new Set<number>();
  for (const stationId of requestedIds) {
    if (obsStationExistsCache.get(stationId)) {
      existingIds.add(stationId);
    }
  }
  return existingIds;
}

async function filterHelperRowsForKnownObsStations(
  helperRows: HelperRow[],
): Promise<FilteredHelperRows> {
  if (helperRows.length === 0) {
    return {
      rows: helperRows,
      missingStationIds: [],
      skippedRowCount: 0,
    };
  }

  const existingStationIds = await fetchKnownObsStationIds(
    helperRows.map((row) => row.station_id),
  );
  if (existingStationIds.size === 0) {
    return {
      rows: [],
      missingStationIds: Array.from(new Set(helperRows.map((row) => row.station_id))).sort(
        (a, b) => a - b,
      ),
      skippedRowCount: helperRows.length,
    };
  }

  const filteredRows: HelperRow[] = [];
  const missingStationIds = new Set<number>();
  let skippedRowCount = 0;

  for (const row of helperRows) {
    if (existingStationIds.has(row.station_id)) {
      filteredRows.push(row);
      continue;
    }
    skippedRowCount += 1;
    missingStationIds.add(row.station_id);
  }

  return {
    rows: filteredRows,
    missingStationIds: Array.from(missingStationIds).sort((a, b) => a - b),
    skippedRowCount,
  };
}

async function fetchHelperRowsPage(window: SyncWindow, offset: number): Promise<HelperRow[]> {
  const args: Record<string, unknown> = {
    p_hour_end_start_exclusive: hourIso(window.hourEndStartExclusive),
    p_hour_end_end_inclusive: hourIso(window.hourEndEndInclusive),
  };
  if (STATION_IDS && STATION_IDS.length > 0) {
    args.p_station_ids = STATION_IDS;
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

async function refreshHelperWindow(window: SyncWindow): Promise<HelperRefreshMetrics> {
  const args: Record<string, unknown> = {
    p_hour_end_start_exclusive: hourIso(window.hourEndStartExclusive),
    p_hour_end_end_inclusive: hourIso(window.hourEndEndInclusive),
    p_reference_hour_end_utc: hourIso(window.referenceHourEnd),
  };
  if (STATION_IDS && STATION_IDS.length > 0) {
    args.p_station_ids = STATION_IDS;
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

async function main(): Promise<void> {
  const startedAt = Date.now();
  const nowUtc = new Date();
  const window = runWindow(nowUtc);

  const referenceHourStart = addHours(window.referenceHourEnd, -1);
  const lateCutoffHour = addHours(referenceHourStart, -LATE_CHANGE_CUTOFF_HOURS);

  let sourceRowsCount = 0;
  let candidateStationHours = 0;
  let rowsUpserted = 0;
  let rowsChanged = 0;
  let stationHoursChanged = 0;
  let stationHoursChangedGt36h = 0;
  let maxChangedLagHours: number | null = null;
  let dailyRowsUpserted = 0;
  let monthlyRowsUpserted = 0;
  let helperPagesFetched = 0;
  let skippedMissingStationRows = 0;
  const skippedMissingStationIds = new Set<number>();
  let helperRefreshMetrics: HelperRefreshMetrics | null = null;
  let runStatus: "ok" | "error" = "ok";
  let errorMessage: string | null = null;

  try {
    if (shouldRefreshHelperWindow()) {
      helperRefreshMetrics = await refreshHelperWindow(window);
    }

    const stationIds = new Set<number>();
    let helperOffset = 0;

    while (true) {
      const rawHelperRows = await fetchHelperRowsPage(window, helperOffset);
      helperPagesFetched += 1;
      sourceRowsCount += rawHelperRows.length;
      candidateStationHours += rawHelperRows.length;

      if (rawHelperRows.length === 0) {
        break;
      }

      const filteredHelperRows = await filterHelperRowsForKnownObsStations(rawHelperRows);
      skippedMissingStationRows += filteredHelperRows.skippedRowCount;
      for (const stationId of filteredHelperRows.missingStationIds) {
        skippedMissingStationIds.add(stationId);
      }

      const helperRows = filteredHelperRows.rows;
      const chunks = chunkRows(helperRows, Math.max(100, HOURLY_UPSERT_CHUNK_SIZE));
      for (const chunk of chunks) {
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

      for (const row of helperRows) {
        stationIds.add(row.station_id);
      }

      if (rawHelperRows.length < HELPER_WINDOW_RPC_PAGE_SIZE) {
        break;
      }
      helperOffset += HELPER_WINDOW_RPC_PAGE_SIZE;
    }

    if (skippedMissingStationIds.size > 0) {
      console.warn(JSON.stringify({
        level: "warning",
        event: "aqi_missing_obs_station_ids_skipped",
        window_start_utc: hourIso(window.hourEndStartExclusive),
        window_end_utc: hourIso(window.hourEndEndInclusive),
        missing_station_id_count: skippedMissingStationIds.size,
        skipped_row_count: skippedMissingStationRows,
        sample_station_ids: Array.from(skippedMissingStationIds).slice(0, 20),
      }));
    }

    if (stationIds.size > 0) {
      const rollupResult = await postgrestRpc<unknown>(
        OBS_AQIDB_SUPABASE_URL,
        OBS_AQI_PRIVILEGED_KEY,
        ROLLUP_REFRESH_RPC,
        {
          p_start_hour_utc: hourIso(window.hourEndStartExclusive),
          p_end_hour_utc: hourIso(window.hourEndEndInclusive),
          p_station_ids: Array.from(stationIds),
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
    candidate_station_hours: candidateStationHours,
    rows_upserted: rowsUpserted,
    rows_changed: rowsChanged,
    station_hours_changed: stationHoursChanged,
    station_hours_changed_gt_36h: stationHoursChangedGt36h,
    max_changed_lag_hours: maxChangedLagHours,
    daily_rows_upserted: dailyRowsUpserted,
    monthly_rows_upserted: monthlyRowsUpserted,
    helper_pages_fetched: helperPagesFetched,
    skipped_missing_station_rows: skippedMissingStationRows,
    skipped_missing_station_id_count: skippedMissingStationIds.size,
    skipped_missing_station_ids_sample: Array.from(skippedMissingStationIds).slice(0, 20),
    helper_refresh_source_rows: helperRefreshMetrics?.source_rows ?? null,
    helper_refresh_rows_upserted: helperRefreshMetrics?.rows_upserted ?? null,
    helper_refresh_station_hours_changed: helperRefreshMetrics?.station_hours_changed ?? null,
    helper_refresh_max_changed_lag_hours: helperRefreshMetrics?.max_changed_lag_hours ?? null,
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
