import {
  addUtcHours,
  buildBackwardDayRange,
  buildCoveredIsoDaysForUtcRange,
  buildAqilevelHistoryRowsForDayFromSourceObservations,
  compareIsoDay,
  computeRollingLocalRetentionWindow,
  DAQI_NO2_BREAKPOINTS,
  DAQI_PM10_ROLLING24H_BREAKPOINTS,
  DAQI_PM25_ROLLING24H_BREAKPOINTS,
  dedupeSourceObservationRows as dedupeSourceObservationRowsCore,
  dayRangeDaysCount,
  EAQI_NO2_BREAKPOINTS,
  EAQI_PM10_BREAKPOINTS,
  EAQI_PM25_BREAKPOINTS,
  extractConnectorIdsFromHistoryDayManifest,
  helperRowsToAqilevelHistoryRows as helperRowsToAqilevelHistoryRowsCore,
  isRetryableAqilevelsWriteError,
  isDayInRollingRetentionWindow,
  isDayLikelyInIngestWindow,
  isRetryableSourceFetchError,
  lookupAqiIndexLevel,
  mapR2ObservationRowsToSourceObservations,
  narrowRowsToDayRange as narrowRowsToDayRangeCore,
  parseBooleanish,
  parseConnectorIds,
  parseIsoDayUtc,
  parsePositiveInt,
  pivotNarrowRowsToHelperRows as pivotNarrowRowsToHelperRowsCore,
  planAqilevelHistoryConnectorWrite,
  parseRunMode,
  parseTriggerMode,
  isSourceAcquisitionPendingError,
  shiftIsoDay,
  sourceObservationRowsToHelperRowsForDay as sourceObservationRowsToHelperRowsForDayCore,
  sourceObservationsToNarrowRows as sourceObservationsToNarrowRowsCore,
  splitChunkLengthForRetry,
  shouldSkipCompletedDay,
  utcDayEndIso,
  utcDayStartIso,
} from "./backfill_core.mjs";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as arrow from "apache-arrow";
import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  type FileMetaData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
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

type RunMode =
  | "local_to_aqilevels"
  | "obs_aqi_to_r2"
  | "source_to_r2"
  | "r2_history_obs_to_aqilevels";
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
  timeseries_id: number;
  station_id: number;
  connector_id: number;
  timestamp_hour_utc: string;
  pollutant_code: string;
  hourly_mean_ugm3: number | null;
  sample_count: number | null;
};

type SourcePollutantCode =
  | "no2"
  | "pm25"
  | "pm10"
  | "temperature"
  | "humidity"
  | "pressure";

type SourceTimeseriesBinding = {
  timeseries_id: number;
  station_id: number;
  station_ref: string;
  timeseries_ref: string;
  pollutant_code: SourcePollutantCode;
};

type SourceConnectorLookup = {
  connector_id: number;
  station_refs: Set<string>;
  binding_by_station_pollutant: Map<string, SourceTimeseriesBinding>;
  binding_by_timeseries_id: Map<number, SourceTimeseriesBinding>;
  binding_by_timeseries_ref: Map<string, SourceTimeseriesBinding>;
  binding_by_timeseries_ref_pollutant: Map<string, SourceTimeseriesBinding>;
};

type SourceAdapterKind =
  | "breathelondon"
  | "sensorcommunity"
  | "openaq"
  | "uk_air_sos";

type StationRefsLookup = {
  station_refs: Set<string>;
  source: "station_filter" | "r2_core" | "ingestdb" | "none";
};

type SourceObservationRow = {
  timeseries_id: number;
  station_id: number;
  pollutant_code: SourcePollutantCode;
  observed_at: string;
  value: number;
};

type UkAirSosDatapoint = {
  observed_at: string;
  value: number | null;
  status: string | null;
};

type UkAirSosTimeseriesProcessResult = {
  binding: SourceTimeseriesBinding;
  station_ref: string;
  timeseries_ref: string;
  rows: SourceObservationRow[];
  raw_point_count: number;
  mapped_point_count: number;
  mirror_reused: boolean;
  mirror_written: boolean;
  no_data_manifest_reused: boolean;
  empty_payload_confirmed: boolean;
  skipped_outside_day: number;
  skipped_null_value: number;
  error_message: string | null;
};

type UkAirSosNoDataManifestEntry = {
  timeseries_ref: string;
  station_ref: string | null;
  recorded_at_utc: string;
};

type UkAirSosTimeseriesFetchResult = {
  payload: unknown;
  mirror_reused: boolean;
  mirror_written: boolean;
  no_data_manifest_reused: boolean;
};

type CoreSnapshotManifestTable = {
  table: string;
  key: string;
};

type CoreSnapshotManifest = {
  day_utc: string | null;
  tables: CoreSnapshotManifestTable[];
  manifest_hash: string | null;
};

type StationIdsLookup = {
  station_ids: number[];
  source: "station_filter" | "r2_core" | "ingestdb" | "none";
};

type StationFilterEntry = {
  station_ids: Set<number>;
  station_refs: Set<string>;
};

type HelperRow = {
  timeseries_id: number;
  station_id: number;
  connector_id: number;
  pollutant_code: "no2" | "pm25" | "pm10";
  timestamp_hour_utc: string;
  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;
  hourly_sample_count: number | null;
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
  timeseries_id: number;
  station_id: number;
  connector_id: number;
  pollutant_code: "no2" | "pm25" | "pm10";
  timestamp_hour_utc: string;
  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;
  hourly_sample_count: number | null;
  daqi_index_level: number | null;
  eaqi_index_level: number | null;
  daqi_no2_index_level: number | null;
  daqi_pm25_rolling24h_index_level: number | null;
  daqi_pm10_rolling24h_index_level: number | null;
  eaqi_no2_index_level: number | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm10_index_level: number | null;
};

type AqilevelsHistoryParquetRow = {
  connector_id: number;
  timeseries_id: number;
  station_id: number;
  pollutant_code: "no2" | "pm25" | "pm10";
  timestamp_hour_utc: string;
  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;
  hourly_sample_count: number | null;
  daqi_index_level: number | null;
  eaqi_index_level: number | null;
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
  min_timeseries_id?: number | null;
  max_timeseries_id?: number | null;
  min_observed_at?: string | null;
  max_observed_at?: string | null;
  min_timestamp_hour_utc?: string | null;
  max_timestamp_hour_utc?: string | null;
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
  min_timeseries_id?: number | null;
  max_timeseries_id?: number | null;
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
  timeseries_hours_changed: number;
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

type R2HistoryObsToAqilevelsDayConnectorResult = {
  day_utc: string;
  connector_id: number;
  status: "complete" | "skipped" | "error" | "dry_run";
  action: "write" | "replace" | "delete" | "skip";
  skip_reason: string | null;
  rows_read: number;
  rows_written_aqilevels: number;
  objects_written_r2: number;
  objects_deleted_r2: number;
  manifest_key: string | null;
  error: string | null;
};

type R2HistoryObsToAqilevelsSummary = {
  mode: "r2_history_obs_to_aqilevels";
  run_id: string;
  dry_run: boolean;
  force_replace: boolean;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
  days_discovered: number;
  days_processed: number;
  connector_day_complete: number;
  connector_day_skipped: number;
  connector_day_error: number;
  rows_read: number;
  rows_written_aqilevels: number;
  objects_written_r2: number;
  objects_deleted_r2: number;
  parquet_files_written: number;
  discovered_days: string[];
  exported_days: string[];
  failed_days: string[];
  discovered_connector_ids: number[];
  day_connector_results: R2HistoryObsToAqilevelsDayConnectorResult[];
  message: string;
};

type SourceToAllSummary = {
  mode: "source_to_r2";
  run_id: string;
  dry_run: boolean;
  from_day_utc: string;
  to_day_utc: string;
  days_planned: number;
  days_processed: number;
  source_connector_day_complete: number;
  source_connector_day_skipped: number;
  source_connector_day_error: number;
  source_processed_days: string[];
  source_failed_days: string[];
  rows_read: number;
  rows_written_aqilevels: number;
  objects_written_r2: number;
  retention_window: Record<string, unknown>;
  local_to_aqilevels_days: string[];
  source_acquisition_pending_days: string[];
  local_to_aqilevels_summary: LocalToAqilevelsSummary | null;
  warnings: string[];
};

type StubModeSummary = {
  mode: "obs_aqi_to_r2" | "source_to_r2" | "r2_history_obs_to_aqilevels";
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
  | R2HistoryObsToAqilevelsSummary
  | SourceToAllSummary
  | StubModeSummary
  | RunFailureSummary;

const INGEST_SUPABASE_URL = optionalEnv("SUPABASE_URL");
const INGEST_PRIVILEGED_KEY = optionalEnvAny(["SB_SECRET_KEY"]);
const OBS_AQIDB_SUPABASE_URL = optionalEnv("OBS_AQIDB_SUPABASE_URL");
const OBS_AQI_PRIVILEGED_KEY = optionalEnv("OBS_AQIDB_SECRET_KEY");

const RPC_SCHEMA = (Deno.env.get("UK_AQ_PUBLIC_SCHEMA") || "uk_aq_public")
  .trim();
const OPS_SCHEMA = (Deno.env.get("UK_AQ_BACKFILL_OPS_SCHEMA") || "uk_aq_public")
  .trim();

const HOURLY_FINGERPRINT_RPC =
  (Deno.env.get("UK_AQ_BACKFILL_HOURLY_FINGERPRINT_RPC") ||
    "uk_aq_rpc_observations_hourly_fingerprint").trim();
const SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC") ||
  "uk_aq_rpc_timeseries_aqi_hourly_source").trim();
const HOURLY_UPSERT_RPC =
  (Deno.env.get("UK_AQ_BACKFILL_AQILEVELS_HOURLY_UPSERT_RPC") ||
    "uk_aq_rpc_timeseries_aqi_hourly_upsert").trim();
const ROLLUP_REFRESH_RPC =
  (Deno.env.get("UK_AQ_BACKFILL_AQILEVELS_ROLLUP_REFRESH_RPC") ||
    "uk_aq_rpc_timeseries_aqi_rollups_refresh").trim();
const OBS_R2_SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_OBS_R2_SOURCE_RPC") ||
  "uk_aq_rpc_observs_history_day_rows").trim();
const AQI_R2_SOURCE_RPC = (Deno.env.get("UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC") ||
  "uk_aq_rpc_aqilevels_history_day_rows").trim();
const AQI_R2_CONNECTOR_COUNTS_RPC =
  (Deno.env.get("UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC") ||
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
const HISTORY_AQILEVELS_SCHEMA_VERSION = 2;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_AQILEVELS_COLUMNS = Object.freeze([
  "connector_id",
  "timeseries_id",
  "station_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "no2_hourly_mean_ugm3",
  "pm25_hourly_mean_ugm3",
  "pm10_hourly_mean_ugm3",
  "pm25_rolling24h_mean_ugm3",
  "pm10_rolling24h_mean_ugm3",
  "hourly_sample_count",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
]);

const OBS_R2_DEPLOY_ENV =
  (Deno.env.get("UK_AQ_DEPLOY_ENV") || Deno.env.get("DEPLOY_ENV") || "dev")
    .trim()
    .toLowerCase();
const OBS_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX") ||
    "history/v1/observations",
) || "history/v1/observations";
const AQI_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX") || "history/v1/aqilevels",
) || "history/v1/aqilevels";
const CORE_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_CORE_PREFIX") || "history/v1/core",
) || "history/v1/core";
const OBS_R2_WRITER_GIT_SHA = (Deno.env.get("GITHUB_SHA") || "").trim() || null;
const OBS_R2_CONFIG = {
  endpoint:
    (Deno.env.get("CFLARE_R2_ENDPOINT") || Deno.env.get("R2_ENDPOINT") || "")
      .trim(),
  bucket: resolveR2BucketByDeployEnv(),
  region:
    (Deno.env.get("CFLARE_R2_REGION") || Deno.env.get("R2_REGION") || "auto")
      .trim() || "auto",
  access_key_id: (Deno.env.get("CFLARE_R2_ACCESS_KEY_ID") ||
    Deno.env.get("R2_ACCESS_KEY_ID") || "").trim(),
  secret_access_key: (Deno.env.get("CFLARE_R2_SECRET_ACCESS_KEY") ||
    Deno.env.get("R2_SECRET_ACCESS_KEY") || "")
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
const SHOULD_USE_R2_CORE_METADATA = RUN_MODE === "source_to_r2" ||
  RUN_MODE === "r2_history_obs_to_aqilevels" || ENABLE_R2_FALLBACK;
const ALLOW_STUB_MODES = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_ALLOW_STUB_MODES"),
  false,
);
const CONNECTOR_IDS = parseConnectorIds(
  optionalEnv("UK_AQ_BACKFILL_CONNECTOR_IDS"),
);
const REQUESTED_STATION_IDS: number[] | null = null;
const REQUESTED_TIMESERIES_IDS = parseConnectorIds(
  optionalEnv("UK_AQ_BACKFILL_TIMESERIES_IDS") ??
    optionalEnv("UK_AQ_BACKFILL_TIMESERIES_ID"),
);

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
const SOURCE_RPC_TIMESERIES_FILTER_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SOURCE_RPC_TIMESERIES_FILTER_CHUNK_SIZE"),
  500,
  25,
  5000,
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
const HOURLY_UPSERT_MIN_CHUNK_SIZE = Math.min(
  HOURLY_UPSERT_CHUNK_SIZE,
  parsePositiveInt(
    Deno.env.get("UK_AQ_BACKFILL_HOURLY_UPSERT_MIN_CHUNK_SIZE"),
    250,
    1,
    10000,
  ),
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
const OBS_R2_PARQUET_ROW_CHUNK_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_OBSERVS_HISTORY_R2_PARQUET_ROW_CHUNK_SIZE") ||
    Deno.env.get("UK_AQ_BACKFILL_OBS_R2_PARQUET_ROW_CHUNK_SIZE"),
  5000,
  500,
  50000,
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
const LOCAL_TIMEZONE =
  (Deno.env.get("UK_AQ_BACKFILL_LOCAL_TIMEZONE") || "Europe/London")
    .trim();
const STATION_ID_PAGE_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_TIMESERIES_ID_PAGE_SIZE"),
  1000,
  100,
  10000,
);
const R2_CORE_LOOKBACK_DAYS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_R2_CORE_LOOKBACK_DAYS"),
  45,
  1,
  3660,
);
const R2_CORE_SNAPSHOT_MAX_BYTES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_R2_CORE_SNAPSHOT_MAX_BYTES"),
  250_000_000,
  1_000_000,
  1_000_000_000,
);

const LEDGER_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_LEDGER_ENABLED"),
  true,
);
const DRY_RUN_WRITE_LEDGER = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_DRY_RUN_WRITE_LEDGER"),
  false,
);
const TEXT_ENCODER = new TextEncoder();

const SOURCE_METADATA_SCHEMA =
  (Deno.env.get("UK_AQ_BACKFILL_METADATA_SCHEMA") || "uk_aq_core").trim();
const SCOMM_SOURCE_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_SOURCE_ENABLED"),
  true,
);
const SCOMM_CONNECTOR_CODE =
  (Deno.env.get("UK_AQ_BACKFILL_SCOMM_CONNECTOR_CODE") || "sensorcommunity")
    .trim()
    .toLowerCase();
const SCOMM_ARCHIVE_BASE_URL = (
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_ARCHIVE_BASE_URL") ||
  "https://archive.sensor.community"
).trim().replace(/\/$/, "");
const SCOMM_INCLUDE_MET_FIELDS = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_INCLUDE_MET_FIELDS"),
  true,
);
const SCOMM_ARCHIVE_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_ARCHIVE_TIMEOUT_MS"),
  120000,
  5000,
  600000,
);
const SCOMM_ARCHIVE_FETCH_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_ARCHIVE_FETCH_RETRIES"),
  3,
  1,
  10,
);
const SCOMM_ARCHIVE_RETRY_BASE_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_SCOMM_ARCHIVE_RETRY_BASE_MS"),
  1500,
  100,
  30000,
);
const SCOMM_RAW_MIRROR_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_SCOMM_RAW_MIRROR_ROOT",
);
const BREATHELONDON_SOURCE_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_SOURCE_ENABLED"),
  true,
);
const BREATHELONDON_CONNECTOR_CODE = (
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_CONNECTOR_CODE") ||
  "breathelondon"
).trim().toLowerCase();
const BREATHELONDON_CONNECTOR_ID_FALLBACK = Number.parseInt(
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_CONNECTOR_ID_FALLBACK") || "3",
  10,
);
const BREATHELONDON_BASE_URL = (
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_BASE_URL") ||
  Deno.env.get("BREATHELONDON_BASE_URL") ||
  "https://api.breathelondon-communities.org/api"
).trim().replace(/\/$/, "");
const BREATHELONDON_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_TIMEOUT_MS"),
  60000,
  5000,
  600000,
);
const BREATHELONDON_FETCH_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_FETCH_RETRIES"),
  3,
  1,
  10,
);
const BREATHELONDON_RETRY_BASE_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_BREATHELONDON_RETRY_BASE_MS"),
  1500,
  100,
  30000,
);
const BREATHELONDON_RAW_MIRROR_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_BREATHELONDON_RAW_MIRROR_ROOT",
);
const BREATHELONDON_API_KEY = optionalEnv("BREATHELONDON_API_KEY");
const BREATHELONDON_SOURCE_SPECIES = Object.freeze([
  {
    species: "IPM25",
    pollutant_code: "pm25" as SourcePollutantCode,
  },
  {
    species: "INO2",
    pollutant_code: "no2" as SourcePollutantCode,
  },
]);
const UK_AIR_SOS_SOURCE_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_SOURCE_ENABLED"),
  true,
);
const UK_AIR_SOS_CONNECTOR_CODE = (
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_CONNECTOR_CODE") || "uk_air_sos"
).trim().toLowerCase();
const UK_AIR_SOS_CONNECTOR_ID_FALLBACK = Number.parseInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_CONNECTOR_ID_FALLBACK") || "1",
  10,
);
const UK_AIR_SOS_BASE_URL = (
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_BASE_URL") ||
  "https://uk-air.defra.gov.uk/sos-ukair/api/v1"
).trim().replace(/\/$/, "");
const UK_AIR_SOS_INCLUDE_MET_FIELDS = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_INCLUDE_MET_FIELDS"),
  true,
);
const UK_AIR_SOS_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_TIMEOUT_MS"),
  60000,
  5000,
  600000,
);
const UK_AIR_SOS_FETCH_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_FETCH_RETRIES"),
  3,
  1,
  10,
);
const UK_AIR_SOS_RETRY_BASE_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_RETRY_BASE_MS"),
  1500,
  100,
  30000,
);
const UK_AIR_SOS_FETCH_CONCURRENCY = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_FETCH_CONCURRENCY"),
  5,
  1,
  20,
);
const UK_AIR_SOS_TIMESERIES_RETRY_ROUNDS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_TIMESERIES_RETRY_ROUNDS"),
  2,
  0,
  10,
);
const UK_AIR_SOS_TIMESERIES_RETRY_BASE_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_UK_AIR_SOS_TIMESERIES_RETRY_BASE_MS"),
  5000,
  100,
  60000,
);
const UK_AIR_SOS_TIMESERIES_RETRY_CONCURRENCY = Math.max(
  1,
  Math.min(
    UK_AIR_SOS_FETCH_CONCURRENCY,
    Math.floor(UK_AIR_SOS_FETCH_CONCURRENCY / 2) || 1,
  ),
);
const UK_AIR_SOS_RAW_MIRROR_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_SOS_RAW_MIRROR_ROOT",
);
const OPENAQ_SOURCE_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_SOURCE_ENABLED"),
  true,
);
const OPENAQ_CONNECTOR_CODE =
  (Deno.env.get("UK_AQ_BACKFILL_OPENAQ_CONNECTOR_CODE") || "openaq").trim()
    .toLowerCase();
const OPENAQ_CONNECTOR_ID_FALLBACK = Number.parseInt(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_CONNECTOR_ID_FALLBACK") || "",
  10,
);
const OPENAQ_ARCHIVE_BASE_URL = (
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_ARCHIVE_BASE_URL") ||
  "https://openaq-data-archive.s3.amazonaws.com"
).trim().replace(/\/$/, "");
const OPENAQ_INCLUDE_MET_FIELDS = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_INCLUDE_MET_FIELDS"),
  true,
);
const OPENAQ_ARCHIVE_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_ARCHIVE_TIMEOUT_MS"),
  120000,
  5000,
  600000,
);
const OPENAQ_ARCHIVE_FETCH_RETRIES = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_ARCHIVE_FETCH_RETRIES"),
  3,
  1,
  10,
);
const OPENAQ_ARCHIVE_RETRY_BASE_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_BACKFILL_OPENAQ_ARCHIVE_RETRY_BASE_MS"),
  1500,
  100,
  30000,
);
const OPENAQ_RAW_MIRROR_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_OPENAQ_RAW_MIRROR_ROOT",
);
const IS_LOCAL_RUN = !optionalEnv("K_SERVICE") && !optionalEnv("K_REVISION");

function nowIso(): string {
  return new Date().toISOString();
}

function encodeJsonBody(payload: unknown): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(payload, null, 2));
}

function logStructured(
  level: "info" | "warning" | "error",
  event: string,
  details: Record<string, unknown>,
) {
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

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 ||
    status === 504;
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

const SOURCE_DB_BY_KIND: Record<
  "ingestdb" | "obs_aqidb",
  SourceDbConfig | null
> = {
  ingestdb: buildSourceDb("ingestdb"),
  obs_aqidb: buildSourceDb("obs_aqidb"),
};

const stationIdCache = new Map<number, StationIdsLookup>();
const stationRefsCache = new Map<number, StationRefsLookup>();
let r2CoreStationIdsByConnectorPromise:
  | Promise<Map<number, number[]> | null>
  | null = null;
let r2CoreStationIdsSourceDayUtc: string | null = null;
let r2CoreStationRefsByConnectorPromise:
  | Promise<Map<number, Set<string>> | null>
  | null = null;
let r2CoreStationRefsSourceDayUtc: string | null = null;
const r2ObservationConnectorIdsByDayCache = new Map<string, number[]>();
const sourceLookupCache = new Map<number, SourceConnectorLookup>();
const connectorCodeCache = new Map<string, number>();
const connectorServiceUrlCache = new Map<number, string | null>();
const stationFilterByConnector = new Map<number, StationFilterEntry>();
let unresolvedRequestedStationIds: number[] = [];
let effectiveConnectorIds: number[] | null = CONNECTOR_IDS
  ? [...CONNECTOR_IDS]
  : null;

function resetRunCaches(): void {
  stationIdCache.clear();
  stationRefsCache.clear();
  r2CoreStationIdsByConnectorPromise = null;
  r2CoreStationIdsSourceDayUtc = null;
  r2CoreStationRefsByConnectorPromise = null;
  r2CoreStationRefsSourceDayUtc = null;
  r2ObservationConnectorIdsByDayCache.clear();
  sourceLookupCache.clear();
  connectorCodeCache.clear();
  connectorServiceUrlCache.clear();
  stationFilterByConnector.clear();
  unresolvedRequestedStationIds = [];
  effectiveConnectorIds = CONNECTOR_IDS ? [...CONNECTOR_IDS] : null;
}

async function postgrestRpc<T>(
  source: SourceDbConfig,
  rpcName: string,
  args: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<RpcResult<T>> {
  const queryString = query ? `?${query.toString()}` : "";
  const url = `${
    normalizeRestUrl(source.base_url)
  }/rpc/${rpcName}${queryString}`;
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
      const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
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
      body: options.method === "GET"
        ? undefined
        : JSON.stringify(options.body ?? {}),
    });

    const contentType = (response.headers.get("content-type") || "")
      .toLowerCase();
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
  after_timeseries_id: number | null;
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

function sortedUniquePositiveInts(values: Iterable<number>): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0) {
      unique.add(Math.trunc(numeric));
    }
  }
  return Array.from(unique).sort((left, right) => left - right);
}

function postgrestIntInFilter(values: Iterable<number>): string {
  const sorted = sortedUniquePositiveInts(values);
  if (!sorted.length) {
    return "in.(-1)";
  }
  return `in.(${sorted.join(",")})`;
}

function intersectSortedPositiveIntLists(
  left: number[] | null,
  right: number[] | null,
): number[] | null {
  if (!left?.length) {
    return right?.length ? [...right] : null;
  }
  if (!right?.length) {
    return [...left];
  }
  const rightSet = new Set(right);
  const intersected = left.filter((value) => rightSet.has(value));
  return intersected.length ? intersected : [];
}

function getStationFilterForConnector(
  connectorId: number,
): StationFilterEntry | null {
  return stationFilterByConnector.get(connectorId) ?? null;
}

async function resolveRequestedStationFilters(): Promise<void> {
  if (!REQUESTED_STATION_IDS?.length) {
    return;
  }
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    throw new Error(
      "UK_AQ_BACKFILL_STATION_IDS requires SUPABASE_URL + SB_SECRET_KEY to resolve station metadata.",
    );
  }

  const requestedStationIds = sortedUniquePositiveInts(REQUESTED_STATION_IDS);
  const unresolvedSet = new Set<number>(requestedStationIds);
  const stationIdsMissingRef = new Set<number>();
  const resolvedByConnector = new Map<number, StationFilterEntry>();

  for (const chunk of chunkList(requestedStationIds, 200)) {
    const query = new URLSearchParams();
    query.set("select", "id,connector_id,station_ref");
    query.set("id", postgrestIntInFilter(chunk));
    query.set("order", "id.asc");
    const result = await postgrestTable<Array<Record<string, unknown>>>(
      INGEST_SUPABASE_URL,
      INGEST_PRIVILEGED_KEY,
      {
        method: "GET",
        schema: SOURCE_METADATA_SCHEMA,
        table: "stations",
        query,
      },
    );
    if (result.error) {
      throw new Error(`station_id lookup failed: ${result.error}`);
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    for (const row of rows) {
      const stationId = Number(row.id);
      const connectorId = Number(row.connector_id);
      const stationRef = String(row.station_ref || "").trim();
      if (!Number.isInteger(stationId) || stationId <= 0) {
        continue;
      }
      unresolvedSet.delete(Math.trunc(stationId));
      if (!Number.isInteger(connectorId) || connectorId <= 0) {
        continue;
      }
      const normalizedConnectorId = Math.trunc(connectorId);
      const entry = resolvedByConnector.get(normalizedConnectorId) || {
        station_ids: new Set<number>(),
        station_refs: new Set<string>(),
      };
      entry.station_ids.add(Math.trunc(stationId));
      if (stationRef) {
        entry.station_refs.add(stationRef);
      } else {
        stationIdsMissingRef.add(Math.trunc(stationId));
      }
      resolvedByConnector.set(normalizedConnectorId, entry);
    }
  }

  unresolvedRequestedStationIds = sortedUniquePositiveInts(unresolvedSet);
  if (!resolvedByConnector.size) {
    throw new Error(
      `No matching stations found for UK_AQ_BACKFILL_STATION_IDS=${
        requestedStationIds.join(",")
      }.`,
    );
  }

  const requestedConnectorFilter = CONNECTOR_IDS?.length
    ? [...CONNECTOR_IDS]
    : null;
  if (requestedConnectorFilter?.length) {
    const requestedSet = new Set(requestedConnectorFilter);
    for (const connectorId of Array.from(resolvedByConnector.keys())) {
      if (!requestedSet.has(connectorId)) {
        resolvedByConnector.delete(connectorId);
      }
    }
    if (!resolvedByConnector.size) {
      throw new Error(
        "station_id filter did not overlap UK_AQ_BACKFILL_CONNECTOR_IDS.",
      );
    }
  }

  stationFilterByConnector.clear();
  for (const [connectorId, entry] of resolvedByConnector.entries()) {
    stationFilterByConnector.set(connectorId, {
      station_ids: new Set(entry.station_ids),
      station_refs: new Set(entry.station_refs),
    });
  }

  const stationConnectorIds = sortedUniquePositiveInts(
    resolvedByConnector.keys(),
  );
  effectiveConnectorIds = intersectSortedPositiveIntLists(
    requestedConnectorFilter,
    stationConnectorIds,
  );
  if (!effectiveConnectorIds?.length) {
    throw new Error("station_id filter resolved no connector_ids to backfill.");
  }

  logStructured("info", "backfill_station_filter_resolved", {
    requested_station_ids: requestedStationIds,
    resolved_connector_ids: effectiveConnectorIds,
    unresolved_station_ids: unresolvedRequestedStationIds,
    stations_missing_station_ref: sortedUniquePositiveInts(
      stationIdsMissingRef,
    ),
  });
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

function buildCoreDayManifestKey(dayUtc: string): string {
  return `${CORE_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/manifest.json`;
}

function buildObsDayPrefix(dayUtc: string): string {
  return `${OBS_R2_HISTORY_PREFIX}/day_utc=${dayUtc}`;
}

function buildAqiDayPrefix(dayUtc: string): string {
  return `${AQI_R2_HISTORY_PREFIX}/day_utc=${dayUtc}`;
}

function buildObsConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${OBS_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildAqiConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${AQI_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildObsConnectorManifestKey(
  dayUtc: string,
  connectorId: number,
): string {
  return `${buildObsConnectorPrefix(dayUtc, connectorId)}/manifest.json`;
}

function buildAqiConnectorManifestKey(
  dayUtc: string,
  connectorId: number,
): string {
  return `${buildAqiConnectorPrefix(dayUtc, connectorId)}/manifest.json`;
}

function buildObsPartKey(
  dayUtc: string,
  connectorId: number,
  partIndex: number,
): string {
  return `${buildObsConnectorPrefix(dayUtc, connectorId)}/part-${
    String(partIndex).padStart(5, "0")
  }.parquet`;
}

function buildAqiPartKey(
  dayUtc: string,
  connectorId: number,
  partIndex: number,
): string {
  return `${buildAqiConnectorPrefix(dayUtc, connectorId)}/part-${
    String(partIndex).padStart(5, "0")
  }.parquet`;
}

function dayBoundsFromIsoDay(
  dayUtc: string,
): { start_iso: string; end_iso: string } {
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
    throw new Error(
      "obs_aqi_to_r2 requires CFLARE_R2_* / R2_* environment variables.",
    );
  }

  const dayManifestPrefix =
    normalizePrefix(options?.day_manifest_prefix || OBS_R2_HISTORY_PREFIX) ||
    OBS_R2_HISTORY_PREFIX;

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
  if (
    args.cursor.after_timeseries_id !== null && args.cursor.after_observed_at
  ) {
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
    throw new Error(
      "obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY",
    );
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
      logStructured(
        "warning",
        "obs_aqi_to_r2_source_rpc_missing_fallback_table",
        {
          rpc_name: OBS_R2_SOURCE_RPC,
        },
      );
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

function normalizeAqilevelsHistoryRows(
  payload: unknown,
  connectorIdFallback: number | null = null,
): AqilevelsHistoryRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const rows: AqilevelsHistoryRow[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const timeseriesId = Number(record.timeseries_id);
    const stationId = Number(record.station_id);
    const connectorIdRaw = Number(record.connector_id);
    const connectorId = Number.isInteger(connectorIdRaw) && connectorIdRaw > 0
      ? Math.trunc(connectorIdRaw)
      : Number.isInteger(connectorIdFallback) && Number(connectorIdFallback) > 0
      ? Math.trunc(Number(connectorIdFallback))
      : null;
    const pollutantCode = parsePollutantCode(record.pollutant_code) as
      | "no2"
      | "pm25"
      | "pm10"
      | null;
    const timestampRaw = typeof record.timestamp_hour_utc === "string"
      ? record.timestamp_hour_utc
      : String(record.timestamp_hour_utc || "");
    const timestampMs = Date.parse(timestampRaw);
    if (
      !Number.isInteger(timeseriesId) || timeseriesId <= 0 ||
      !Number.isInteger(stationId) || stationId <= 0 ||
      connectorId === null || connectorId <= 0 ||
      !pollutantCode ||
      !Number.isFinite(timestampMs)
    ) {
      continue;
    }

    const timestamp = new Date(timestampMs);
    timestamp.setUTCMinutes(0, 0, 0);

    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Math.trunc(stationId),
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      timestamp_hour_utc: timestamp.toISOString(),
      no2_hourly_mean_ugm3: toSafeNumber(record.no2_hourly_mean_ugm3),
      pm25_hourly_mean_ugm3: toSafeNumber(record.pm25_hourly_mean_ugm3),
      pm10_hourly_mean_ugm3: toSafeNumber(record.pm10_hourly_mean_ugm3),
      pm25_rolling24h_mean_ugm3: toSafeNumber(record.pm25_rolling24h_mean_ugm3),
      pm10_rolling24h_mean_ugm3: toSafeNumber(record.pm10_rolling24h_mean_ugm3),
      hourly_sample_count: toSafeNumber(record.hourly_sample_count),
      daqi_index_level: toSafeNumber(record.daqi_index_level),
      eaqi_index_level: toSafeNumber(record.eaqi_index_level),
      daqi_no2_index_level: toSafeNumber(record.daqi_no2_index_level),
      daqi_pm25_rolling24h_index_level: toSafeNumber(
        record.daqi_pm25_rolling24h_index_level,
      ),
      daqi_pm10_rolling24h_index_level: toSafeNumber(
        record.daqi_pm10_rolling24h_index_level,
      ),
      eaqi_no2_index_level: toSafeNumber(record.eaqi_no2_index_level),
      eaqi_pm25_index_level: toSafeNumber(record.eaqi_pm25_index_level),
      eaqi_pm10_index_level: toSafeNumber(record.eaqi_pm10_index_level),
    });
  }

  rows.sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return 0;
  });

  return rows;
}

async function fetchAqilevelsConnectorCountsForDay(
  dayUtc: string,
): Promise<Map<number, number>> {
  const source = SOURCE_DB_BY_KIND.obs_aqidb;
  if (!source) {
    throw new Error(
      "obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY",
    );
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
        logStructured(
          "error",
          "obs_aqi_to_r2_aqi_connector_counts_rpc_missing",
          {
            rpc_name: AQI_R2_CONNECTOR_COUNTS_RPC,
            status: response.status,
          },
        );
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
      p_after_timeseries_id: args.cursor.after_timeseries_id,
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
      throw new Error(
        `obs_aqi_to_r2 requires ${AQI_R2_SOURCE_RPC} RPC (uk_aq_public) for AQI export`,
      );
    }
    throw new Error(
      `obs_aqi_to_r2 AQI source RPC failed for day=${args.day_utc} connector=${args.connector_id}: ${response.error.message}`,
    );
  }

  aqiR2SourceRpcAvailable = true;
  return normalizeAqilevelsHistoryRows(response.data, args.connector_id);
}

async function fetchAqilevelsHistoryRowsPage(
  dayUtc: string,
  connectorId: number,
  cursor: AqilevelsHistorySourceCursor,
  limit: number,
): Promise<AqilevelsHistoryRow[]> {
  const source = SOURCE_DB_BY_KIND.obs_aqidb;
  if (!source) {
    throw new Error(
      "obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY",
    );
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

function statsFromFileEntries(
  fileEntries: ObsHistoryFileEntry[],
  totalRows: number,
) {
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

function summarizeObservationPartRows(
  rows: ObsHistoryParquetRow[],
): {
  min_timeseries_id: number | null;
  max_timeseries_id: number | null;
  min_observed_at: string | null;
  max_observed_at: string | null;
} {
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  let minObservedAt: string | null = null;
  let maxObservedAt: string | null = null;

  for (const row of rows) {
    const timeseriesId = Number(row.timeseries_id);
    if (Number.isFinite(timeseriesId) && timeseriesId > 0) {
      const normalizedTimeseriesId = Math.trunc(timeseriesId);
      if (minTimeseriesId === null || normalizedTimeseriesId < minTimeseriesId) {
        minTimeseriesId = normalizedTimeseriesId;
      }
      if (maxTimeseriesId === null || normalizedTimeseriesId > maxTimeseriesId) {
        maxTimeseriesId = normalizedTimeseriesId;
      }
    }

    const observedAt = typeof row.observed_at === "string" ? row.observed_at : null;
    if (observedAt) {
      if (!minObservedAt || observedAt < minObservedAt) {
        minObservedAt = observedAt;
      }
      if (!maxObservedAt || observedAt > maxObservedAt) {
        maxObservedAt = observedAt;
      }
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
  };
}

function summarizeAqilevelsPartRows(
  rows: AqilevelsHistoryParquetRow[],
): {
  min_timeseries_id: number | null;
  max_timeseries_id: number | null;
  min_timestamp_hour_utc: string | null;
  max_timestamp_hour_utc: string | null;
} {
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;

  for (const row of rows) {
    const timeseriesId = Number(row.timeseries_id);
    if (Number.isFinite(timeseriesId) && timeseriesId > 0) {
      const normalizedTimeseriesId = Math.trunc(timeseriesId);
      if (minTimeseriesId === null || normalizedTimeseriesId < minTimeseriesId) {
        minTimeseriesId = normalizedTimeseriesId;
      }
      if (maxTimeseriesId === null || normalizedTimeseriesId > maxTimeseriesId) {
        maxTimeseriesId = normalizedTimeseriesId;
      }
    }

    const timestampHourUtc = typeof row.timestamp_hour_utc === "string"
      ? row.timestamp_hour_utc
      : null;
    if (timestampHourUtc) {
      if (!minTimestampHourUtc || timestampHourUtc < minTimestampHourUtc) {
        minTimestampHourUtc = timestampHourUtc;
      }
      if (!maxTimestampHourUtc || timestampHourUtc > maxTimestampHourUtc) {
        maxTimestampHourUtc = timestampHourUtc;
      }
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
  };
}

function withManifestHash<T extends Record<string, unknown>>(
  payloadWithoutHash: T,
): T & { manifest_hash: string } {
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
  const totalBytes = args.fileEntries.reduce(
    (sum, entry) => sum + Number(entry.bytes || 0),
    0,
  );
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
      min_timeseries_id: entry.min_timeseries_id ?? null,
      max_timeseries_id: entry.max_timeseries_id ?? null,
      min_observed_at: entry.min_observed_at ?? null,
      max_observed_at: entry.max_observed_at ?? null,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key)))
    .sort((a, b) => a.localeCompare(b));
  const totalRows = args.connectorManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce(
    (sum, file) => sum + toSafeInt(file.bytes),
    0,
  );
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
      etag_or_hash: typeof entry.etag_or_hash === "string"
        ? entry.etag_or_hash
        : null,
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
  const totalBytes = args.fileEntries.reduce(
    (sum, entry) => sum + Number(entry.bytes || 0),
    0,
  );
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  for (const entry of args.fileEntries) {
    const entryMin = Number(entry.min_timeseries_id);
    const entryMax = Number(entry.max_timeseries_id);
    if (Number.isFinite(entryMin) && entryMin > 0) {
      const normalized = Math.trunc(entryMin);
      if (minTimeseriesId === null || normalized < minTimeseriesId) {
        minTimeseriesId = normalized;
      }
    }
    if (Number.isFinite(entryMax) && entryMax > 0) {
      const normalized = Math.trunc(entryMax);
      if (maxTimeseriesId === null || normalized > maxTimeseriesId) {
        maxTimeseriesId = normalized;
      }
    }
  }
  const stats = statsFromFileEntries(args.fileEntries, args.sourceRowCount);

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
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
  connectorManifests: Array<
    AqilevelsConnectorManifest & Record<string, unknown>
  >;
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
      min_timeseries_id: entry.min_timeseries_id ?? null,
      max_timeseries_id: entry.max_timeseries_id ?? null,
      min_timestamp_hour_utc: entry.min_timestamp_hour_utc ?? null,
      max_timestamp_hour_utc: entry.max_timestamp_hour_utc ?? null,
    }))
  );
  const parquetObjectKeys = Array.from(new Set(files.map((entry) => entry.key)))
    .sort((a, b) => a.localeCompare(b));
  const totalRows = args.connectorManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce(
    (sum, file) => sum + toSafeInt(file.bytes),
    0,
  );
  const connectorIds = args.connectorManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => a - b);

  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
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
    const manifestMinTimeseriesId = Number(manifest.min_timeseries_id);
    if (Number.isFinite(manifestMinTimeseriesId) && manifestMinTimeseriesId > 0) {
      const normalized = Math.trunc(manifestMinTimeseriesId);
      if (minTimeseriesId === null || normalized < minTimeseriesId) {
        minTimeseriesId = normalized;
      }
    }
    const manifestMaxTimeseriesId = Number(manifest.max_timeseries_id);
    if (Number.isFinite(manifestMaxTimeseriesId) && manifestMaxTimeseriesId > 0) {
      const normalized = Math.trunc(manifestMaxTimeseriesId);
      if (maxTimeseriesId === null || normalized > maxTimeseriesId) {
        maxTimeseriesId = normalized;
      }
    }
  }

  const stats = statsFromFileEntries(
    files.map((entry) => ({
      key: entry.key,
      row_count: toSafeInt(entry.row_count),
      bytes: toSafeInt(entry.bytes),
      etag_or_hash: typeof entry.etag_or_hash === "string"
        ? entry.etag_or_hash
        : null,
    })),
    totalRows,
  );

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: args.runId,
    source_row_count: totalRows,
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
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
      min_timeseries_id: manifest.min_timeseries_id ?? null,
      max_timeseries_id: manifest.max_timeseries_id ?? null,
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
  const wasmPath = path.resolve(
    moduleDir,
    "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm",
  );
  const wasmBytes = fs.readFileSync(wasmPath);
  (parquetWasm as unknown as {
    initSync: (args: { module: Uint8Array }) => void;
  }).initSync({
    module: wasmBytes,
  });
  parquetWasmInitialized = true;
}

function parquetWriterProperties(
  rowGroupSize: number,
  createdBy: string,
): unknown {
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
    value: rows.map((
      row,
    ) => (row.value === null || row.value === undefined
      ? null
      : Number(row.value))
    ),
  });
  const wasmTable = (parquetWasm as unknown as {
    Table: { fromIPCStream: (bytes: Uint8Array) => unknown };
  }).Table.fromIPCStream(
    (arrow as unknown as {
      tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
    }).tableToIPC(
      table,
      "stream",
    ),
  );
  return (parquetWasm as unknown as {
    writeParquet: (table: unknown, writerProperties: unknown) => Uint8Array;
  }).writeParquet(
    wasmTable,
    parquetWriterProperties(
      OBS_R2_ROW_GROUP_SIZE,
      HISTORY_OBSERVATIONS_WRITER_VERSION,
    ),
  );
}

function rowsToAqiParquetBuffer(
  rows: AqilevelsHistoryParquetRow[],
): Uint8Array {
  ensureParquetWasmInitialized();
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
    tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
  }).tableFromArrays({
    connector_id: rows.map((row) => row.connector_id),
    timeseries_id: rows.map((row) => row.timeseries_id),
    station_id: rows.map((row) => row.station_id),
    pollutant_code: rows.map((row) => row.pollutant_code),
    timestamp_hour_utc: rows.map((row) => new Date(row.timestamp_hour_utc)),
    no2_hourly_mean_ugm3: rows.map((row) => row.no2_hourly_mean_ugm3),
    pm25_hourly_mean_ugm3: rows.map((row) => row.pm25_hourly_mean_ugm3),
    pm10_hourly_mean_ugm3: rows.map((row) => row.pm10_hourly_mean_ugm3),
    pm25_rolling24h_mean_ugm3: rows.map((row) => row.pm25_rolling24h_mean_ugm3),
    pm10_rolling24h_mean_ugm3: rows.map((row) => row.pm10_rolling24h_mean_ugm3),
    hourly_sample_count: rows.map((row) => row.hourly_sample_count),
    daqi_index_level: rows.map((row) => row.daqi_index_level),
    eaqi_index_level: rows.map((row) => row.eaqi_index_level),
    daqi_no2_index_level: rows.map((row) => row.daqi_no2_index_level),
    daqi_pm25_rolling24h_index_level: rows.map((row) =>
      row.daqi_pm25_rolling24h_index_level
    ),
    daqi_pm10_rolling24h_index_level: rows.map((row) =>
      row.daqi_pm10_rolling24h_index_level
    ),
    eaqi_no2_index_level: rows.map((row) => row.eaqi_no2_index_level),
    eaqi_pm25_index_level: rows.map((row) => row.eaqi_pm25_index_level),
    eaqi_pm10_index_level: rows.map((row) => row.eaqi_pm10_index_level),
  });
  const wasmTable = (parquetWasm as unknown as {
    Table: { fromIPCStream: (bytes: Uint8Array) => unknown };
  }).Table.fromIPCStream(
    (arrow as unknown as {
      tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
    }).tableToIPC(
      table,
      "stream",
    ),
  );
  return (parquetWasm as unknown as {
    writeParquet: (table: unknown, writerProperties: unknown) => Uint8Array;
  }).writeParquet(
    wasmTable,
    parquetWriterProperties(
      OBS_R2_ROW_GROUP_SIZE,
      HISTORY_AQILEVELS_WRITER_VERSION,
    ),
  );
}

async function deleteR2Keys(keys: string[]): Promise<number> {
  if (!keys.length) {
    return 0;
  }
  let deletedCount = 0;
  for (const batch of chunkList(keys, 1000)) {
    const result = await r2DeleteObjects({ r2: OBS_R2_CONFIG, keys: batch });
    if (result.errors.length > 0) {
      throw new Error(JSON.stringify(result.errors.slice(0, 10)));
    }
    deletedCount += batch.length;
  }
  return deletedCount;
}

async function deleteR2Prefix(prefix: string): Promise<number> {
  const entries = await r2ListAllObjects({
    r2: OBS_R2_CONFIG,
    prefix: `${prefix}/`,
    max_keys: 1000,
  });
  const keys = entries.map((entry) => String(entry.key || "").trim()).filter(
    Boolean,
  );
  try {
    return await deleteR2Keys(keys);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`R2 delete prefix failed (${prefix}): ${message}`);
  }
}

async function deleteR2ObjectIfExists(key: string): Promise<number> {
  const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
  if (!head.exists) {
    return 0;
  }
  try {
    return await deleteR2Keys([key]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`R2 delete object failed (${key}): ${message}`);
  }
}

async function loadExistingConnectorManifest(
  dayUtc: string,
  connectorId: number,
): Promise<ObsConnectorManifest | null> {
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
  const files = filesRaw
    .map((entry): ObsHistoryFileEntry | null => {
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
        etag_or_hash:
          item.etag_or_hash === null || item.etag_or_hash === undefined
            ? null
            : String(item.etag_or_hash),
        min_timeseries_id: Number.isFinite(Number(item.min_timeseries_id))
          ? Math.trunc(Number(item.min_timeseries_id))
          : null,
        max_timeseries_id: Number.isFinite(Number(item.max_timeseries_id))
          ? Math.trunc(Number(item.max_timeseries_id))
          : null,
        min_observed_at: typeof item.min_observed_at === "string"
          ? item.min_observed_at
          : null,
        max_observed_at: typeof item.max_observed_at === "string"
          ? item.max_observed_at
          : null,
      };
    })
    .filter((value): value is ObsHistoryFileEntry => value !== null);

  return {
    day_utc: parseOptionalDay(record.day_utc) || dayUtc,
    connector_id: Number(record.connector_id) || connectorId,
    run_id: String(record.run_id || ""),
    manifest_key: String(record.manifest_key || key).trim() || key,
    source_row_count: toSafeInt(record.source_row_count),
    min_observed_at: typeof record.min_observed_at === "string"
      ? record.min_observed_at
      : null,
    max_observed_at: typeof record.max_observed_at === "string"
      ? record.max_observed_at
      : null,
    parquet_object_keys: Array.isArray(record.parquet_object_keys)
      ? record.parquet_object_keys.map((value) => String(value || "").trim())
        .filter(Boolean)
      : files.map((file) => file.key),
    file_count: toSafeInt(record.file_count) || files.length,
    total_bytes: toSafeInt(record.total_bytes) ||
      files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

async function loadR2ObservationConnectorIdsForDay(
  dayUtc: string,
): Promise<number[]> {
  const cached = r2ObservationConnectorIdsByDayCache.get(dayUtc);
  if (cached) {
    return cached;
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    r2ObservationConnectorIdsByDayCache.set(dayUtc, []);
    return [];
  }

  const key = buildObsDayManifestKey(dayUtc);
  const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
  if (!head.exists) {
    r2ObservationConnectorIdsByDayCache.set(dayUtc, []);
    return [];
  }

  const object = await r2GetObject({ r2: OBS_R2_CONFIG, key });
  let parsed: unknown;
  try {
    parsed = JSON.parse(object.body.toString("utf8"));
  } catch {
    throw new Error(`Invalid observation day manifest JSON: ${key}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Observation day manifest is not an object: ${key}`);
  }

  const resolved = extractConnectorIdsFromHistoryDayManifest(
    parsed as Record<string, unknown>,
  );
  r2ObservationConnectorIdsByDayCache.set(dayUtc, resolved);
  return resolved;
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
    await deleteR2Prefix(
      buildObsConnectorPrefix(args.day_utc, args.connector_id),
    );
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
    const partSummary = summarizeObservationPartRows(partRows);
    fileEntries.push({
      key: partKey,
      row_count: partRows.length,
      bytes: typeof head.bytes === "number" && Number.isFinite(head.bytes)
        ? Math.trunc(head.bytes)
        : Math.trunc(putResult.bytes),
      etag_or_hash: head.etag || putResult.etag || null,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_observed_at: partSummary.min_observed_at,
      max_observed_at: partSummary.max_observed_at,
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
    const cursorUnchanged =
      nextCursor.after_timeseries_id === cursor.after_timeseries_id &&
      nextCursor.after_observed_at === cursor.after_observed_at;
    if (cursorUnchanged) {
      throw new Error(
        `obs_aqi_to_r2 observations pagination cursor did not advance for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }
    cursor = nextCursor;
  }

  await flushPart();

  const manifestKey = buildObsConnectorManifestKey(
    args.day_utc,
    args.connector_id,
  );
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
  const manifestHead = await r2HeadObject({
    r2: OBS_R2_CONFIG,
    key: manifestKey,
  });
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
  const files = filesRaw
    .map((entry): ObsHistoryFileEntry | null => {
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
        etag_or_hash:
          item.etag_or_hash === null || item.etag_or_hash === undefined
            ? null
            : String(item.etag_or_hash),
        min_timeseries_id: Number.isFinite(Number(item.min_timeseries_id))
          ? Math.max(1, Math.trunc(Number(item.min_timeseries_id)))
          : null,
        max_timeseries_id: Number.isFinite(Number(item.max_timeseries_id))
          ? Math.max(1, Math.trunc(Number(item.max_timeseries_id)))
          : null,
        min_timestamp_hour_utc: typeof item.min_timestamp_hour_utc === "string"
          ? item.min_timestamp_hour_utc
          : null,
        max_timestamp_hour_utc: typeof item.max_timestamp_hour_utc === "string"
          ? item.max_timestamp_hour_utc
          : null,
      };
    })
    .filter((value): value is ObsHistoryFileEntry => value !== null);

  return {
    day_utc: parseOptionalDay(record.day_utc) || dayUtc,
    connector_id: Number(record.connector_id) || connectorId,
    run_id: String(record.run_id || ""),
    manifest_key: String(record.manifest_key || key).trim() || key,
    source_row_count: toSafeInt(record.source_row_count),
    min_timeseries_id: Number.isFinite(Number(record.min_timeseries_id))
      ? Math.max(1, Math.trunc(Number(record.min_timeseries_id)))
      : null,
    max_timeseries_id: Number.isFinite(Number(record.max_timeseries_id))
      ? Math.max(1, Math.trunc(Number(record.max_timeseries_id)))
      : null,
    min_timestamp_hour_utc: typeof record.min_timestamp_hour_utc === "string"
      ? record.min_timestamp_hour_utc
      : null,
    max_timestamp_hour_utc: typeof record.max_timestamp_hour_utc === "string"
      ? record.max_timestamp_hour_utc
      : null,
    parquet_object_keys: Array.isArray(record.parquet_object_keys)
      ? record.parquet_object_keys.map((value) => String(value || "").trim())
        .filter(Boolean)
      : files.map((file) => file.key),
    file_count: toSafeInt(record.file_count) || files.length,
    total_bytes: toSafeInt(record.total_bytes) ||
      files.reduce((sum, file) => sum + file.bytes, 0),
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
    await deleteR2Prefix(
      buildAqiConnectorPrefix(args.day_utc, args.connector_id),
    );
  }

  const parquetRowsBuffer: AqilevelsHistoryParquetRow[] = [];
  const fileEntries: ObsHistoryFileEntry[] = [];
  let rowsRead = 0;
  let partIndex = 0;
  let pageCount = 0;
  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;
  let cursor: AqilevelsHistorySourceCursor = {
    after_timeseries_id: null,
    after_timestamp_hour_utc: null,
  };

  const flushPart = async (): Promise<void> => {
    if (!parquetRowsBuffer.length) {
      return;
    }
    const partRows = parquetRowsBuffer.splice(0, parquetRowsBuffer.length);
    const partSummary = summarizeAqilevelsPartRows(partRows);
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
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
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
      if (
        !minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc
      ) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (
        !maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc
      ) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }
      parquetRowsBuffer.push({
        connector_id: args.connector_id,
        timeseries_id: row.timeseries_id,
        station_id: row.station_id,
        pollutant_code: row.pollutant_code,
        timestamp_hour_utc: row.timestamp_hour_utc,
        no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
        pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
        pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
        pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
        pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
        hourly_sample_count: row.hourly_sample_count,
        daqi_index_level: row.daqi_index_level,
        eaqi_index_level: row.eaqi_index_level,
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
      after_timeseries_id: last.timeseries_id,
      after_timestamp_hour_utc: last.timestamp_hour_utc,
    };
    const cursorUnchanged =
      nextCursor.after_timeseries_id === cursor.after_timeseries_id &&
      nextCursor.after_timestamp_hour_utc === cursor.after_timestamp_hour_utc;
    if (cursorUnchanged) {
      throw new Error(
        `obs_aqi_to_r2 AQI pagination cursor did not advance for day=${args.day_utc} connector=${args.connector_id}`,
      );
    }
    cursor = nextCursor;
  }

  await flushPart();

  const manifestKey = buildAqiConnectorManifestKey(
    args.day_utc,
    args.connector_id,
  );
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
  const manifestHead = await r2HeadObject({
    r2: OBS_R2_CONFIG,
    key: manifestKey,
  });
  if (!manifestHead.exists) {
    throw new Error(
      `Missing AQI connector manifest after upload: ${manifestKey}`,
    );
  }

  return {
    rows_read: rowsRead,
    objects_written_r2: fileEntries.length + 1,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest,
  };
}

async function exportObsConnectorRowsToR2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
  rows: ObsHistoryRow[];
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  manifest_key: string;
  connector_manifest: ObsConnectorManifest & Record<string, unknown>;
}> {
  if (FORCE_REPLACE) {
    await deleteR2Prefix(
      buildObsConnectorPrefix(args.day_utc, args.connector_id),
    );
  }

  const sortedRows = [...args.rows].sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.observed_at < right.observed_at) return -1;
    if (left.observed_at > right.observed_at) return 1;
    return 0;
  });
  const fileEntries: ObsHistoryFileEntry[] = [];
  let minObservedAt: string | null = null;
  let maxObservedAt: string | null = null;

  const rowChunks = chunkRows(sortedRows, OBS_R2_PART_MAX_ROWS);
  for (let partIndex = 0; partIndex < rowChunks.length; partIndex += 1) {
    const chunk = rowChunks[partIndex];
    if (!chunk.length) {
      continue;
    }
    for (const row of chunk) {
      if (!minObservedAt || row.observed_at < minObservedAt) {
        minObservedAt = row.observed_at;
      }
      if (!maxObservedAt || row.observed_at > maxObservedAt) {
        maxObservedAt = row.observed_at;
      }
    }
    const parquetRows: ObsHistoryParquetRow[] = chunk.map((row) => ({
      connector_id: args.connector_id,
      timeseries_id: row.timeseries_id,
      observed_at: row.observed_at,
      value: row.value,
    }));
    const partSummary = summarizeObservationPartRows(parquetRows);
    const partKey = buildObsPartKey(args.day_utc, args.connector_id, partIndex);
    const putResult = await r2PutObject({
      r2: OBS_R2_CONFIG,
      key: partKey,
      body: rowsToParquetBuffer(parquetRows),
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing parquet part after upload: ${partKey}`);
    }
    fileEntries.push({
      key: partKey,
      row_count: chunk.length,
      bytes: typeof head.bytes === "number" && Number.isFinite(head.bytes)
        ? Math.trunc(head.bytes)
        : Math.trunc(putResult.bytes),
      etag_or_hash: head.etag || putResult.etag || null,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_observed_at: partSummary.min_observed_at,
      max_observed_at: partSummary.max_observed_at,
    });
  }

  const manifestKey = buildObsConnectorManifestKey(
    args.day_utc,
    args.connector_id,
  );
  const connectorManifest = createObsConnectorManifest({
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey,
    sourceRowCount: sortedRows.length,
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

  return {
    rows_read: sortedRows.length,
    objects_written_r2: fileEntries.length + 1,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest,
  };
}

async function exportAqiConnectorRowsToR2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
  rows: AqilevelsHistoryRow[];
  force_replace?: boolean;
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  parquet_files_written: number;
  manifest_key: string;
  connector_manifest: AqilevelsConnectorManifest & Record<string, unknown>;
}> {
  if (args.force_replace ?? FORCE_REPLACE) {
    await deleteR2Prefix(
      buildAqiConnectorPrefix(args.day_utc, args.connector_id),
    );
  }

  const sortedRows = [...args.rows].sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return 0;
  });
  const fileEntries: ObsHistoryFileEntry[] = [];
  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;

  const rowChunks = chunkRows(sortedRows, OBS_R2_PART_MAX_ROWS);
  for (let partIndex = 0; partIndex < rowChunks.length; partIndex += 1) {
    const chunk = rowChunks[partIndex];
    if (!chunk.length) {
      continue;
    }
    for (const row of chunk) {
      if (
        !minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc
      ) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (
        !maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc
      ) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }
    }
    const parquetRows: AqilevelsHistoryParquetRow[] = chunk.map((row) => ({
      connector_id: args.connector_id,
      timeseries_id: row.timeseries_id,
      station_id: row.station_id,
      pollutant_code: row.pollutant_code,
      timestamp_hour_utc: row.timestamp_hour_utc,
      no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
      pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
      pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
      pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
      pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
      hourly_sample_count: row.hourly_sample_count,
      daqi_index_level: row.daqi_index_level,
      eaqi_index_level: row.eaqi_index_level,
      daqi_no2_index_level: row.daqi_no2_index_level,
      daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level,
      daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level,
      eaqi_no2_index_level: row.eaqi_no2_index_level,
      eaqi_pm25_index_level: row.eaqi_pm25_index_level,
      eaqi_pm10_index_level: row.eaqi_pm10_index_level,
    }));
    const partSummary = summarizeAqilevelsPartRows(parquetRows);
    const partKey = buildAqiPartKey(args.day_utc, args.connector_id, partIndex);
    const putResult = await r2PutObject({
      r2: OBS_R2_CONFIG,
      key: partKey,
      body: rowsToAqiParquetBuffer(parquetRows),
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing AQI parquet part after upload: ${partKey}`);
    }
    fileEntries.push({
      key: partKey,
      row_count: chunk.length,
      bytes: typeof head.bytes === "number" && Number.isFinite(head.bytes)
        ? Math.trunc(head.bytes)
        : Math.trunc(putResult.bytes),
      etag_or_hash: head.etag || putResult.etag || null,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
    });
  }

  const manifestKey = buildAqiConnectorManifestKey(
    args.day_utc,
    args.connector_id,
  );
  const connectorManifest = createAqiConnectorManifest({
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey,
    sourceRowCount: sortedRows.length,
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

  return {
    rows_read: sortedRows.length,
    objects_written_r2: fileEntries.length + 1,
    parquet_files_written: fileEntries.length,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest,
  };
}

async function loadAllObsConnectorManifestsForDay(
  dayUtc: string,
): Promise<Array<ObsConnectorManifest & Record<string, unknown>>> {
  const prefix = `${buildObsDayPrefix(dayUtc)}/connector_id=`;
  const objects = await r2ListAllObjects({
    r2: OBS_R2_CONFIG,
    prefix,
    max_keys: 1000,
  });
  const manifests: Array<ObsConnectorManifest & Record<string, unknown>> = [];
  for (const object of objects) {
    const key = String(object.key || "");
    const match = key.match(/connector_id=(\d+)\/manifest\.json$/);
    if (!match) {
      continue;
    }
    const connectorId = Number(match[1]);
    if (!Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    const manifest = await loadExistingConnectorManifest(
      dayUtc,
      Math.trunc(connectorId),
    );
    if (manifest) {
      manifests.push(
        manifest as ObsConnectorManifest & Record<string, unknown>,
      );
    }
  }
  manifests.sort((left, right) =>
    Number(left.connector_id) - Number(right.connector_id)
  );
  return manifests;
}

async function loadAllAqiConnectorManifestsForDay(
  dayUtc: string,
): Promise<Array<AqilevelsConnectorManifest & Record<string, unknown>>> {
  const prefix = `${buildAqiDayPrefix(dayUtc)}/connector_id=`;
  const objects = await r2ListAllObjects({
    r2: OBS_R2_CONFIG,
    prefix,
    max_keys: 1000,
  });
  const manifests: Array<AqilevelsConnectorManifest & Record<string, unknown>> =
    [];
  for (const object of objects) {
    const key = String(object.key || "");
    const match = key.match(/connector_id=(\d+)\/manifest\.json$/);
    if (!match) {
      continue;
    }
    const connectorId = Number(match[1]);
    if (!Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    const manifest = await loadExistingAqiConnectorManifest(
      dayUtc,
      Math.trunc(connectorId),
    );
    if (manifest) {
      manifests.push(
        manifest as AqilevelsConnectorManifest & Record<string, unknown>,
      );
    }
  }
  manifests.sort((left, right) =>
    Number(left.connector_id) - Number(right.connector_id)
  );
  return manifests;
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

function parseSourceRows(
  payload: unknown,
): { narrowRows: SourceNarrowRow[]; helperRows: HelperRow[] } {
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
    const timeseriesId = Number(row.timeseries_id);
    const stationId = Number(row.station_id);
    const connectorId = Number(row.connector_id);
    const timestampHour = parseIsoHour(row.timestamp_hour_utc);
    if (
      !Number.isInteger(timeseriesId) || timeseriesId <= 0 ||
      !Number.isInteger(stationId) || stationId <= 0 ||
      !Number.isInteger(connectorId) || connectorId <= 0 ||
      !timestampHour
    ) {
      continue;
    }

    const pollutantCode = parsePollutantCode(row.pollutant_code) as
      | "no2"
      | "pm25"
      | "pm10"
      | null;
    if (pollutantCode) {
      narrowRows.push({
        timeseries_id: Math.trunc(timeseriesId),
        station_id: Math.trunc(stationId),
        connector_id: Math.trunc(connectorId),
        timestamp_hour_utc: timestampHour,
        pollutant_code: pollutantCode,
        hourly_mean_ugm3: toSafeNumber(row.hourly_mean_ugm3),
        sample_count: toSafeNumber(row.sample_count),
      });
      continue;
    }

    const helperPollutant = toSafeNumber(row.no2_hourly_mean_ugm3) !== null
      ? "no2"
      : toSafeNumber(row.pm25_hourly_mean_ugm3) !== null
      ? "pm25"
      : toSafeNumber(row.pm10_hourly_mean_ugm3) !== null
      ? "pm10"
      : null;
    if (!helperPollutant) {
      continue;
    }

    helperRows.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Math.trunc(stationId),
      connector_id: Math.trunc(connectorId),
      pollutant_code: helperPollutant,
      timestamp_hour_utc: timestampHour,
      no2_hourly_mean_ugm3: toSafeNumber(row.no2_hourly_mean_ugm3),
      pm25_hourly_mean_ugm3: toSafeNumber(row.pm25_hourly_mean_ugm3),
      pm10_hourly_mean_ugm3: toSafeNumber(row.pm10_hourly_mean_ugm3),
      pm25_rolling24h_mean_ugm3: toSafeNumber(row.pm25_rolling24h_mean_ugm3),
      pm10_rolling24h_mean_ugm3: toSafeNumber(row.pm10_rolling24h_mean_ugm3),
      hourly_sample_count: toSafeNumber(row.hourly_sample_count),
    });
  }

  narrowRows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    return left.pollutant_code.localeCompare(right.pollutant_code);
  });

  helperRows.sort((left, right) => {
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return left.timeseries_id - right.timeseries_id;
  });

  return { narrowRows, helperRows };
}

function pivotNarrowRowsToHelperRows(
  narrowRows: SourceNarrowRow[],
): HelperRow[] {
  return pivotNarrowRowsToHelperRowsCore(narrowRows) as HelperRow[];
}

function narrowToDayRange(
  helperRows: HelperRow[],
  dayUtc: string,
): HelperRow[] {
  return narrowRowsToDayRangeCore(helperRows, dayUtc) as HelperRow[];
}

function parseHourlyUpsertMetrics(payload: unknown): HourlyUpsertMetrics {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("hourly upsert RPC returned no rows");
  }
  const row = payload[0] as Record<string, unknown>;
  return {
    rows_changed: toSafeInt(row.rows_changed),
    timeseries_hours_changed: toSafeInt(
      row.timeseries_hours_changed ?? row.station_hours_changed,
    ),
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

function addHourlyUpsertMetrics(
  left: HourlyUpsertMetrics,
  right: HourlyUpsertMetrics,
): HourlyUpsertMetrics {
  return {
    rows_changed: left.rows_changed + right.rows_changed,
    timeseries_hours_changed:
      left.timeseries_hours_changed + right.timeseries_hours_changed,
  };
}

async function upsertAqilevelsChunkWithRetry(
  aqilevelsSource: SourceDbConfig,
  chunk: HelperRow[],
  lateCutoffHour: string,
  referenceHour: string,
  splitDepth = 0,
): Promise<HourlyUpsertMetrics> {
  const result = await postgrestRpc<unknown>(
    aqilevelsSource,
    HOURLY_UPSERT_RPC,
    {
      p_rows: chunk,
      p_late_cutoff_hour: lateCutoffHour,
      p_reference_hour: referenceHour,
    },
  );
  if (!result.error) {
    return parseHourlyUpsertMetrics(result.data);
  }

  const message = result.error.message;
  const splitLengths = splitChunkLengthForRetry(
    chunk.length,
    HOURLY_UPSERT_MIN_CHUNK_SIZE,
  );
  if (splitLengths && isRetryableAqilevelsWriteError(message)) {
    const [leftLength] = splitLengths;
    const leftChunk = chunk.slice(0, leftLength);
    const rightChunk = chunk.slice(leftLength);
    logStructured("warning", "local_to_aqilevels_hourly_upsert_chunk_retry_split", {
      chunk_rows: chunk.length,
      left_chunk_rows: leftChunk.length,
      right_chunk_rows: rightChunk.length,
      min_chunk_rows: HOURLY_UPSERT_MIN_CHUNK_SIZE,
      split_depth: splitDepth,
      error: message,
    });
    const leftMetrics = await upsertAqilevelsChunkWithRetry(
      aqilevelsSource,
      leftChunk,
      lateCutoffHour,
      referenceHour,
      splitDepth + 1,
    );
    const rightMetrics = await upsertAqilevelsChunkWithRetry(
      aqilevelsSource,
      rightChunk,
      lateCutoffHour,
      referenceHour,
      splitDepth + 1,
    );
    return addHourlyUpsertMetrics(leftMetrics, rightMetrics);
  }

  throw new Error(`AQI levels hourly upsert RPC failed: ${message}`);
}

function parseCoreSnapshotManifest(
  manifestText: string,
  manifestKey: string,
): CoreSnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(`Invalid core snapshot manifest JSON: ${manifestKey}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid core snapshot manifest object: ${manifestKey}`);
  }

  const record = parsed as Record<string, unknown>;
  const tablesRaw = Array.isArray(record.tables) ? record.tables : [];
  const tables: CoreSnapshotManifestTable[] = [];
  for (const item of tablesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const table = String((item as Record<string, unknown>).table || "").trim();
    const key = String((item as Record<string, unknown>).key || "").trim();
    if (!table || !key) {
      continue;
    }
    tables.push({ table, key });
  }

  return {
    day_utc: parseOptionalDay(record.day_utc),
    tables,
    manifest_hash: typeof record.manifest_hash === "string"
      ? record.manifest_hash.trim() || null
      : null,
  };
}

function findCoreTableKey(
  manifest: CoreSnapshotManifest,
  tableName: string,
): string | null {
  const needle = tableName.trim().toLowerCase();
  for (const table of manifest.tables) {
    if (table.table.trim().toLowerCase() === needle) {
      return table.key;
    }
  }
  return null;
}

async function findLatestCoreSnapshotManifestInfo(): Promise<
  { day_utc: string; manifest_key: string } | null
> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  for (let offset = 0; offset <= R2_CORE_LOOKBACK_DAYS; offset += 1) {
    const dayUtc = shiftIsoDay(todayUtc, -offset);
    const manifestKey = buildCoreDayManifestKey(dayUtc);
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: manifestKey });
    if (head.exists) {
      return {
        day_utc: dayUtc,
        manifest_key: manifestKey,
      };
    }
  }

  return null;
}

function decodeCoreTableText(body: Uint8Array, tableKey: string): string {
  const bytes = body.byteLength;
  if (bytes > R2_CORE_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `Core snapshot table object too large (${bytes} bytes) for ${tableKey}; increase UK_AQ_BACKFILL_R2_CORE_SNAPSHOT_MAX_BYTES if needed.`,
    );
  }

  const decoder = new TextDecoder();
  if (tableKey.endsWith(".gz")) {
    const uncompressed = zlib.gunzipSync(body);
    return decoder.decode(uncompressed);
  }
  return decoder.decode(body);
}

function buildStationIdsIndexFromTimeseriesNdjson(
  ndjsonText: string,
): Map<number, number[]> {
  const connectorToStations = new Map<number, Set<number>>();
  const lines = ndjsonText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }

    const record = row as Record<string, unknown>;
    const connectorId = Number(record.connector_id);
    const stationId = Number(record.station_id);
    if (!Number.isInteger(connectorId) || connectorId <= 0) {
      continue;
    }
    if (!Number.isInteger(stationId) || stationId <= 0) {
      continue;
    }

    const connectorKey = Math.trunc(connectorId);
    const stationKey = Math.trunc(stationId);
    const stationSet = connectorToStations.get(connectorKey) ||
      new Set<number>();
    stationSet.add(stationKey);
    connectorToStations.set(connectorKey, stationSet);
  }

  const result = new Map<number, number[]>();
  for (const [connectorId, stationSet] of connectorToStations.entries()) {
    result.set(
      connectorId,
      Array.from(stationSet).sort((left, right) => left - right),
    );
  }
  return result;
}

function parseCoreTableRows(
  ndjsonText: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of ndjsonText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object" && !Array.isArray(row)) {
        rows.push(row as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return rows;
}

function buildStationRefsIndexFromStationsNdjson(
  ndjsonText: string,
): Map<number, Set<string>> {
  const connectorToStationRefs = new Map<number, Set<string>>();
  const rows = parseCoreTableRows(ndjsonText);
  for (const row of rows) {
    const connectorId = Number(row.connector_id);
    const stationRef = String(row.station_ref || "").trim();
    if (!Number.isInteger(connectorId) || connectorId <= 0 || !stationRef) {
      continue;
    }
    const connectorKey = Math.trunc(connectorId);
    const refSet = connectorToStationRefs.get(connectorKey) ||
      new Set<string>();
    refSet.add(stationRef);
    connectorToStationRefs.set(connectorKey, refSet);
  }
  return connectorToStationRefs;
}

function buildPhenomenonPollutantMap(
  phenomenonRows: Array<Record<string, unknown>>,
  observedPropertyCodeById: Map<number, string>,
): Map<number, SourcePollutantCode> {
  const pollutantByPhenomenonId = new Map<number, SourcePollutantCode>();
  for (const row of phenomenonRows) {
    const phenomenonId = Number(row.id);
    if (!Number.isInteger(phenomenonId) || phenomenonId <= 0) {
      continue;
    }

    const observedPropertyId = Number(row.observed_property_id);
    const observedPropertyCode =
      Number.isInteger(observedPropertyId) && observedPropertyId > 0
        ? observedPropertyCodeById.get(Math.trunc(observedPropertyId)) || null
        : null;
    const parsedFromObservedProperty = observedPropertyCode
      ? parseSourcePollutantCode(observedPropertyCode)
      : null;

    let parsedFromSourceLabel: SourcePollutantCode | null = null;
    const sourceLabel = String(row.source_label || row.eionet_uri || "").trim();
    if (sourceLabel) {
      const separator = sourceLabel.lastIndexOf(":");
      const suffix = separator >= 0
        ? sourceLabel.slice(separator + 1)
        : sourceLabel;
      parsedFromSourceLabel = parseSourcePollutantCode(suffix);
    }

    const pollutantCode = parsedFromObservedProperty || parsedFromSourceLabel;
    if (!pollutantCode) {
      continue;
    }
    pollutantByPhenomenonId.set(Math.trunc(phenomenonId), pollutantCode);
  }
  return pollutantByPhenomenonId;
}

function buildOpenaqSourceLookupFromMetadataRows(args: {
  connectorId: number;
  stationRows: Array<Record<string, unknown>>;
  timeseriesRows: Array<Record<string, unknown>>;
  phenomenonRows: Array<Record<string, unknown>>;
  observedPropertyRows: Array<Record<string, unknown>>;
  candidateStationRefs?: Iterable<string>;
}): SourceConnectorLookup {
  const {
    connectorId,
    stationRows,
    timeseriesRows,
    phenomenonRows,
    observedPropertyRows,
    candidateStationRefs,
  } = args;

  const stationRefByStationId = new Map<number, string>();
  const stationRefs = new Set<string>();
  for (const row of stationRows) {
    const stationId = Number(row.id);
    const stationRef = String(row.station_ref || "").trim();
    if (!Number.isInteger(stationId) || stationId <= 0 || !stationRef) {
      continue;
    }
    stationRefByStationId.set(Math.trunc(stationId), stationRef);
    stationRefs.add(stationRef);
  }
  if (candidateStationRefs) {
    for (const stationRefRaw of candidateStationRefs) {
      const stationRef = String(stationRefRaw || "").trim();
      if (stationRef) {
        stationRefs.add(stationRef);
      }
    }
  }

  const observedPropertyCodeById = new Map<number, string>();
  for (const row of observedPropertyRows) {
    const id = Number(row.id);
    const code = String(row.code || "").trim();
    if (!Number.isInteger(id) || id <= 0 || !code) {
      continue;
    }
    observedPropertyCodeById.set(Math.trunc(id), code);
  }

  const pollutantByPhenomenonId = buildPhenomenonPollutantMap(
    phenomenonRows,
    observedPropertyCodeById,
  );

  const bindingByStationPollutant = new Map<string, SourceTimeseriesBinding>();
  const bindingByTimeseriesId = new Map<number, SourceTimeseriesBinding>();
  const bindingByTimeseriesRef = new Map<string, SourceTimeseriesBinding>();
  const bindingByTimeseriesRefPollutant = new Map<
    string,
    SourceTimeseriesBinding
  >();

  for (const row of timeseriesRows) {
    const timeseriesId = Number(row.id);
    const stationId = Number(row.station_id);
    const phenomenonId = Number(row.phenomenon_id);
    const timeseriesRef = String(row.timeseries_ref || "").trim();
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
      continue;
    }
    if (!Number.isInteger(stationId) || stationId <= 0) {
      continue;
    }
    if (!timeseriesRef) {
      continue;
    }

    const stationRef = stationRefByStationId.get(Math.trunc(stationId));
    if (!stationRef) {
      continue;
    }
    stationRefs.add(stationRef);

    const pollutantCode = (Number.isInteger(phenomenonId) && phenomenonId > 0)
      ? pollutantByPhenomenonId.get(Math.trunc(phenomenonId)) || null
      : null;
    if (!pollutantCode) {
      continue;
    }

    const binding: SourceTimeseriesBinding = {
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Math.trunc(stationId),
      station_ref: stationRef,
      timeseries_ref: timeseriesRef,
      pollutant_code: pollutantCode,
    };

    const stationKey = stationPollutantKey(
      binding.station_ref,
      binding.pollutant_code,
    );
    const existingByStation = bindingByStationPollutant.get(stationKey);
    if (
      !existingByStation ||
      binding.timeseries_id < existingByStation.timeseries_id
    ) {
      bindingByStationPollutant.set(stationKey, binding);
    }
    const existingById = bindingByTimeseriesId.get(binding.timeseries_id);
    if (!existingById || binding.station_id < existingById.station_id) {
      bindingByTimeseriesId.set(binding.timeseries_id, binding);
    }

    const existingByTimeseries = bindingByTimeseriesRef.get(
      binding.timeseries_ref,
    );
    if (
      !existingByTimeseries ||
      binding.timeseries_id < existingByTimeseries.timeseries_id
    ) {
      bindingByTimeseriesRef.set(binding.timeseries_ref, binding);
    }

    const sensorPollutantKey = stationPollutantKey(
      binding.timeseries_ref,
      binding.pollutant_code,
    );
    const existingBySensorPollutant = bindingByTimeseriesRefPollutant.get(
      sensorPollutantKey,
    );
    if (
      !existingBySensorPollutant ||
      binding.timeseries_id < existingBySensorPollutant.timeseries_id
    ) {
      bindingByTimeseriesRefPollutant.set(sensorPollutantKey, binding);
    }
  }

  return {
    connector_id: connectorId,
    station_refs: stationRefs,
    binding_by_station_pollutant: bindingByStationPollutant,
    binding_by_timeseries_id: bindingByTimeseriesId,
    binding_by_timeseries_ref: bindingByTimeseriesRef,
    binding_by_timeseries_ref_pollutant: bindingByTimeseriesRefPollutant,
  };
}

async function loadR2CoreStationIdsByConnector(): Promise<
  Map<number, number[]> | null
> {
  if (!SHOULD_USE_R2_CORE_METADATA) {
    return null;
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }
  if (r2CoreStationIdsByConnectorPromise) {
    return await r2CoreStationIdsByConnectorPromise;
  }

  r2CoreStationIdsByConnectorPromise = (async () => {
    try {
      const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
      if (!snapshotInfo) {
        logStructured("warning", "backfill_core_snapshot_manifest_missing", {
          core_prefix: CORE_R2_HISTORY_PREFIX,
          lookback_days: R2_CORE_LOOKBACK_DAYS,
        });
        return null;
      }

      const manifestObject = await r2GetObject({
        r2: OBS_R2_CONFIG,
        key: snapshotInfo.manifest_key,
      });
      const manifestText = new TextDecoder().decode(manifestObject.body);
      const manifest = parseCoreSnapshotManifest(
        manifestText,
        snapshotInfo.manifest_key,
      );
      const timeseriesTableKey = findCoreTableKey(manifest, "timeseries");
      if (!timeseriesTableKey) {
        logStructured(
          "warning",
          "backfill_core_snapshot_missing_timeseries_table",
          {
            manifest_key: snapshotInfo.manifest_key,
            snapshot_day_utc: snapshotInfo.day_utc,
          },
        );
        return null;
      }

      const timeseriesObject = await r2GetObject({
        r2: OBS_R2_CONFIG,
        key: timeseriesTableKey,
      });
      const ndjsonText = decodeCoreTableText(
        timeseriesObject.body,
        timeseriesTableKey,
      );
      const byConnector = buildStationIdsIndexFromTimeseriesNdjson(ndjsonText);
      r2CoreStationIdsSourceDayUtc = manifest.day_utc || snapshotInfo.day_utc;

      let totalStationIds = 0;
      for (const stationIds of byConnector.values()) {
        totalStationIds += stationIds.length;
      }
      logStructured("info", "backfill_core_snapshot_loaded", {
        snapshot_day_utc: r2CoreStationIdsSourceDayUtc,
        manifest_key: snapshotInfo.manifest_key,
        timeseries_table_key: timeseriesTableKey,
        connector_count: byConnector.size,
        station_id_count: totalStationIds,
      });

      return byConnector;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("warning", "backfill_core_snapshot_load_failed", {
        core_prefix: CORE_R2_HISTORY_PREFIX,
        error: message,
      });
      return null;
    }
  })();

  return await r2CoreStationIdsByConnectorPromise;
}

async function loadR2CoreStationRefsByConnector(): Promise<
  Map<number, Set<string>> | null
> {
  if (!SHOULD_USE_R2_CORE_METADATA) {
    return null;
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }
  if (r2CoreStationRefsByConnectorPromise) {
    return await r2CoreStationRefsByConnectorPromise;
  }

  r2CoreStationRefsByConnectorPromise = (async () => {
    try {
      const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
      if (!snapshotInfo) {
        return null;
      }

      const manifestObject = await r2GetObject({
        r2: OBS_R2_CONFIG,
        key: snapshotInfo.manifest_key,
      });
      const manifestText = new TextDecoder().decode(manifestObject.body);
      const manifest = parseCoreSnapshotManifest(
        manifestText,
        snapshotInfo.manifest_key,
      );
      const stationsTableKey = findCoreTableKey(manifest, "stations");
      if (!stationsTableKey) {
        return null;
      }

      const stationsObject = await r2GetObject({
        r2: OBS_R2_CONFIG,
        key: stationsTableKey,
      });
      const ndjsonText = decodeCoreTableText(
        stationsObject.body,
        stationsTableKey,
      );
      const byConnector = buildStationRefsIndexFromStationsNdjson(ndjsonText);
      r2CoreStationRefsSourceDayUtc = manifest.day_utc || snapshotInfo.day_utc;
      return byConnector;
    } catch {
      return null;
    }
  })();

  return await r2CoreStationRefsByConnectorPromise;
}

async function fetchAllRowsPaged(args: {
  baseUrl: string;
  privilegedKey: string;
  schema: string;
  table: string;
  query: URLSearchParams;
  pageSize?: number;
  label: string;
}): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let start = 0;
  const pageSize = args.pageSize || STATION_ID_PAGE_SIZE;

  while (true) {
    const result = await postgrestTable<Array<Record<string, unknown>>>(
      args.baseUrl,
      args.privilegedKey,
      {
        method: "GET",
        schema: args.schema,
        table: args.table,
        query: args.query,
        rangeStart: start,
        rangeEnd: start + pageSize - 1,
      },
    );

    if (result.error) {
      throw new Error(`${args.label}: ${result.error}`);
    }

    const pageRows = Array.isArray(result.data) ? result.data : [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      break;
    }
    start += pageSize;
  }

  return rows;
}

async function fetchStationRefsForConnector(
  connectorId: number,
): Promise<StationRefsLookup> {
  const stationFilter = getStationFilterForConnector(connectorId);
  if (stationFilter) {
    const lookup: StationRefsLookup = {
      station_refs: new Set(stationFilter.station_refs),
      source: "station_filter",
    };
    stationRefsCache.set(connectorId, lookup);
    return lookup;
  }

  const cached = stationRefsCache.get(connectorId);
  if (cached) {
    return cached;
  }

  const shouldTryR2Core = SHOULD_USE_R2_CORE_METADATA;
  if (shouldTryR2Core) {
    const stationRefsByConnector = await loadR2CoreStationRefsByConnector();
    if (stationRefsByConnector) {
      const refs = stationRefsByConnector.get(connectorId) || new Set<string>();
      if (refs.size > 0) {
        const lookup: StationRefsLookup = {
          station_refs: new Set(refs),
          source: "r2_core",
        };
        stationRefsCache.set(connectorId, lookup);
        logStructured("info", "backfill_station_refs_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core",
          station_ref_count: refs.size,
          core_snapshot_day_utc: r2CoreStationRefsSourceDayUtc,
        });
        return lookup;
      }
    }
  }

  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    const lookup: StationRefsLookup = {
      station_refs: new Set<string>(),
      source: "none",
    };
    stationRefsCache.set(connectorId, lookup);
    return lookup;
  }

  try {
    const query = new URLSearchParams();
    query.set("select", "station_ref");
    query.set("connector_id", `eq.${connectorId}`);
    query.set("station_ref", "not.is.null");
    query.set("order", "station_ref.asc");
    const rows = await fetchAllRowsPaged({
      baseUrl: INGEST_SUPABASE_URL,
      privilegedKey: INGEST_PRIVILEGED_KEY,
      schema: SOURCE_METADATA_SCHEMA,
      table: "stations",
      query,
      label: `station refs query failed for connector=${connectorId}`,
    });
    const stationRefs = new Set<string>();
    for (const row of rows) {
      const stationRef = String(row.station_ref || "").trim();
      if (stationRef) {
        stationRefs.add(stationRef);
      }
    }

    const lookup: StationRefsLookup = {
      station_refs: stationRefs,
      source: stationRefs.size > 0 ? "ingestdb" : "none",
    };
    stationRefsCache.set(connectorId, lookup);
    if (lookup.source === "ingestdb" && shouldTryR2Core) {
      logStructured("info", "backfill_station_refs_resolved", {
        connector_id: connectorId,
        metadata_source: "ingestdb_fallback",
        station_ref_count: stationRefs.size,
      });
    } else if (lookup.source === "none") {
      logStructured("warning", "backfill_station_refs_missing", {
        connector_id: connectorId,
        tried_r2_core: shouldTryR2Core,
        tried_ingestdb: true,
      });
    }
    return lookup;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("warning", "backfill_station_refs_query_failed", {
      connector_id: connectorId,
      error: message,
    });
    const lookup: StationRefsLookup = {
      station_refs: new Set<string>(),
      source: "none",
    };
    stationRefsCache.set(connectorId, lookup);
    return lookup;
  }
}

async function fetchStationIdsForConnector(
  connectorId: number,
): Promise<StationIdsLookup> {
  const stationFilter = getStationFilterForConnector(connectorId);
  if (stationFilter) {
    const lookup: StationIdsLookup = {
      station_ids: sortedUniquePositiveInts(stationFilter.station_ids),
      source: "station_filter",
    };
    stationIdCache.set(connectorId, lookup);
    return lookup;
  }

  const cached = stationIdCache.get(connectorId);
  if (cached) {
    return cached;
  }

  const shouldTryR2Core = SHOULD_USE_R2_CORE_METADATA;
  if (shouldTryR2Core) {
    const stationIdsByConnector = await loadR2CoreStationIdsByConnector();
    if (stationIdsByConnector) {
      const stationIds = stationIdsByConnector.get(connectorId) || [];
      if (stationIds.length > 0) {
        const lookup: StationIdsLookup = {
          station_ids: stationIds,
          source: "r2_core",
        };
        stationIdCache.set(connectorId, lookup);
        logStructured("info", "backfill_station_ids_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core",
          station_id_count: stationIds.length,
          core_snapshot_day_utc: r2CoreStationIdsSourceDayUtc,
        });
        return lookup;
      }
    }
  }

  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    const lookup: StationIdsLookup = {
      station_ids: [],
      source: "none",
    };
    stationIdCache.set(connectorId, lookup);
    return lookup;
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
  const lookup: StationIdsLookup = {
    station_ids: sorted,
    source: sorted.length > 0 ? "ingestdb" : "none",
  };
  stationIdCache.set(connectorId, lookup);

  if (lookup.source === "ingestdb" && shouldTryR2Core) {
    logStructured("info", "backfill_station_ids_resolved", {
      connector_id: connectorId,
      metadata_source: "ingestdb_fallback",
      station_id_count: sorted.length,
    });
  } else if (lookup.source === "none") {
    logStructured("warning", "backfill_station_ids_missing", {
      connector_id: connectorId,
      tried_r2_core: shouldTryR2Core,
      tried_ingestdb: true,
    });
  }

  return lookup;
}

function stationPollutantKey(
  stationRef: string,
  pollutantCode: SourcePollutantCode,
): string {
  return `${stationRef}|${pollutantCode}`;
}

function parseSourcePollutantCode(value: string): SourcePollutantCode | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const compact = normalized.replace(/[^a-z0-9]+/g, "");
  if (compact === "ino2") return "no2";
  if (compact === "ipm25") return "pm25";
  if (compact === "no2") return "no2";
  if (compact === "pm10") return "pm10";
  if (compact === "pm25") return "pm25";
  if (compact === "temperature" || compact === "temp") return "temperature";
  if (
    compact === "humidity" || compact === "relativehumidity" || compact === "rh"
  ) return "humidity";
  if (compact === "pressure" || compact === "airpressure") return "pressure";
  return null;
}

function parseTimeseriesRefBinding(
  record: Record<string, unknown>,
): SourceTimeseriesBinding | null {
  const timeseriesId = Number(record.id);
  const stationId = Number(record.station_id);
  const timeseriesRef = String(record.timeseries_ref || "").trim();
  if (!Number.isInteger(timeseriesId) || timeseriesId <= 0) {
    return null;
  }
  if (!Number.isInteger(stationId) || stationId <= 0) {
    return null;
  }
  if (!timeseriesRef) {
    return null;
  }
  const separator = timeseriesRef.lastIndexOf(":");
  if (separator <= 0 || separator === timeseriesRef.length - 1) {
    return null;
  }
  const stationRef = timeseriesRef.slice(0, separator).trim();
  const pollutantCode = parseSourcePollutantCode(
    timeseriesRef.slice(separator + 1),
  );
  if (!stationRef || !pollutantCode) {
    return null;
  }

  return {
    timeseries_id: Math.trunc(timeseriesId),
    station_id: Math.trunc(stationId),
    station_ref: stationRef,
    timeseries_ref: timeseriesRef,
    pollutant_code: pollutantCode,
  };
}

function buildSourceLookupFromTimeseriesRows(
  connectorId: number,
  rows: Array<Record<string, unknown>>,
): SourceConnectorLookup {
  const stationRefs = new Set<string>();
  const bindingByStationPollutant = new Map<string, SourceTimeseriesBinding>();
  const bindingByTimeseriesId = new Map<number, SourceTimeseriesBinding>();
  const bindingByTimeseriesRef = new Map<string, SourceTimeseriesBinding>();
  const bindingByTimeseriesRefPollutant = new Map<
    string,
    SourceTimeseriesBinding
  >();

  for (const row of rows) {
    const binding = parseTimeseriesRefBinding(row);
    if (!binding) {
      continue;
    }
    stationRefs.add(binding.station_ref);
    const key = stationPollutantKey(
      binding.station_ref,
      binding.pollutant_code,
    );
    const existing = bindingByStationPollutant.get(key);
    if (!existing || binding.timeseries_id < existing.timeseries_id) {
      bindingByStationPollutant.set(key, binding);
    }
    const existingById = bindingByTimeseriesId.get(binding.timeseries_id);
    if (!existingById || binding.station_id < existingById.station_id) {
      bindingByTimeseriesId.set(binding.timeseries_id, binding);
    }
    const existingByRef = bindingByTimeseriesRef.get(binding.timeseries_ref);
    if (!existingByRef || binding.timeseries_id < existingByRef.timeseries_id) {
      bindingByTimeseriesRef.set(binding.timeseries_ref, binding);
    }
    const sensorPollutantKey = stationPollutantKey(
      binding.timeseries_ref,
      binding.pollutant_code,
    );
    const existingByRefPollutant = bindingByTimeseriesRefPollutant.get(
      sensorPollutantKey,
    );
    if (
      !existingByRefPollutant ||
      binding.timeseries_id < existingByRefPollutant.timeseries_id
    ) {
      bindingByTimeseriesRefPollutant.set(sensorPollutantKey, binding);
    }
  }

  return {
    connector_id: connectorId,
    station_refs: stationRefs,
    binding_by_station_pollutant: bindingByStationPollutant,
    binding_by_timeseries_id: bindingByTimeseriesId,
    binding_by_timeseries_ref: bindingByTimeseriesRef,
    binding_by_timeseries_ref_pollutant: bindingByTimeseriesRefPollutant,
  };
}

async function loadR2CoreSourceLookupForConnector(
  connectorId: number,
): Promise<SourceConnectorLookup | null> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
  if (!snapshotInfo) {
    return null;
  }
  const manifestObject = await r2GetObject({
    r2: OBS_R2_CONFIG,
    key: snapshotInfo.manifest_key,
  });
  const manifest = parseCoreSnapshotManifest(
    new TextDecoder().decode(manifestObject.body),
    snapshotInfo.manifest_key,
  );
  const timeseriesTableKey = findCoreTableKey(manifest, "timeseries");
  if (!timeseriesTableKey) {
    return null;
  }

  const timeseriesObject = await r2GetObject({
    r2: OBS_R2_CONFIG,
    key: timeseriesTableKey,
  });
  const ndjsonText = decodeCoreTableText(
    timeseriesObject.body,
    timeseriesTableKey,
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const line of ndjsonText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      const rowConnectorId = Number(row.connector_id);
      if (Number.isInteger(rowConnectorId) && rowConnectorId === connectorId) {
        rows.push(row);
      }
    } catch {
      continue;
    }
  }

  if (!rows.length) {
    return null;
  }

  return buildSourceLookupFromTimeseriesRows(connectorId, rows);
}

async function loadIngestSourceLookupForConnector(
  connectorId: number,
): Promise<SourceConnectorLookup | null> {
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    return null;
  }

  const rows: Array<Record<string, unknown>> = [];
  let start = 0;
  while (true) {
    const query = new URLSearchParams();
    query.set("select", "id,station_id,timeseries_ref,connector_id");
    query.set("connector_id", `eq.${connectorId}`);
    query.set("timeseries_ref", "not.is.null");
    query.set("station_id", "not.is.null");
    query.set("order", "id.asc");

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
      logStructured("warning", "source_lookup_ingest_query_failed", {
        connector_id: connectorId,
        error: result.error,
      });
      return null;
    }

    const pageRows = Array.isArray(result.data) ? result.data : [];
    rows.push(...pageRows);

    if (pageRows.length < STATION_ID_PAGE_SIZE) {
      break;
    }
    start += STATION_ID_PAGE_SIZE;
  }

  if (!rows.length) {
    return null;
  }
  return buildSourceLookupFromTimeseriesRows(connectorId, rows);
}

async function loadIngestOpenaqSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
  adapterLabel = "openaq",
): Promise<SourceConnectorLookup | null> {
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    return null;
  }

  const stationQuery = new URLSearchParams();
  stationQuery.set("select", "id,station_ref,connector_id");
  stationQuery.set("connector_id", `eq.${connectorId}`);
  stationQuery.set("station_ref", "not.is.null");
  stationQuery.set("order", "id.asc");

  const timeseriesQuery = new URLSearchParams();
  timeseriesQuery.set(
    "select",
    "id,station_id,timeseries_ref,connector_id,phenomenon_id",
  );
  timeseriesQuery.set("connector_id", `eq.${connectorId}`);
  timeseriesQuery.set("timeseries_ref", "not.is.null");
  timeseriesQuery.set("station_id", "not.is.null");
  timeseriesQuery.set("order", "id.asc");

  const phenomenaQuery = new URLSearchParams();
  phenomenaQuery.set(
    "select",
    "id,connector_id,source_label,observed_property_id",
  );
  phenomenaQuery.set("connector_id", `eq.${connectorId}`);
  phenomenaQuery.set("order", "id.asc");

  const observedPropertiesQuery = new URLSearchParams();
  observedPropertiesQuery.set("select", "id,code");
  observedPropertiesQuery.set("order", "id.asc");

  const [stationRows, timeseriesRows, phenomenonRows, observedPropertyRows] =
    await Promise.all([
      fetchAllRowsPaged({
        baseUrl: INGEST_SUPABASE_URL,
        privilegedKey: INGEST_PRIVILEGED_KEY,
        schema: SOURCE_METADATA_SCHEMA,
        table: "stations",
        query: stationQuery,
        label: `${adapterLabel} station lookup failed for connector=${connectorId}`,
      }),
      fetchAllRowsPaged({
        baseUrl: INGEST_SUPABASE_URL,
        privilegedKey: INGEST_PRIVILEGED_KEY,
        schema: SOURCE_METADATA_SCHEMA,
        table: "timeseries",
        query: timeseriesQuery,
        label:
          `${adapterLabel} timeseries lookup failed for connector=${connectorId}`,
      }),
      fetchAllRowsPaged({
        baseUrl: INGEST_SUPABASE_URL,
        privilegedKey: INGEST_PRIVILEGED_KEY,
        schema: SOURCE_METADATA_SCHEMA,
        table: "phenomena",
        query: phenomenaQuery,
        label:
          `${adapterLabel} phenomena lookup failed for connector=${connectorId}`,
      }),
      fetchAllRowsPaged({
        baseUrl: INGEST_SUPABASE_URL,
        privilegedKey: INGEST_PRIVILEGED_KEY,
        schema: SOURCE_METADATA_SCHEMA,
        table: "observed_properties",
        query: observedPropertiesQuery,
        label:
          `${adapterLabel} observed_properties lookup failed for connector=${connectorId}`,
      }),
    ]);

  return buildOpenaqSourceLookupFromMetadataRows({
    connectorId,
    stationRows,
    timeseriesRows,
    phenomenonRows,
    observedPropertyRows,
    candidateStationRefs,
  });
}

async function loadR2CoreOpenaqSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
  _adapterLabel = "openaq",
): Promise<SourceConnectorLookup | null> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
  if (!snapshotInfo) {
    return null;
  }
  const manifestObject = await r2GetObject({
    r2: OBS_R2_CONFIG,
    key: snapshotInfo.manifest_key,
  });
  const manifest = parseCoreSnapshotManifest(
    new TextDecoder().decode(manifestObject.body),
    snapshotInfo.manifest_key,
  );
  const stationsTableKey = findCoreTableKey(manifest, "stations");
  const timeseriesTableKey = findCoreTableKey(manifest, "timeseries");
  const phenomenaTableKey = findCoreTableKey(manifest, "phenomena");
  const observedPropertiesTableKey = findCoreTableKey(
    manifest,
    "observed_properties",
  );
  if (
    !stationsTableKey || !timeseriesTableKey || !phenomenaTableKey ||
    !observedPropertiesTableKey
  ) {
    return null;
  }

  const [
    stationsObject,
    timeseriesObject,
    phenomenaObject,
    observedPropertiesObject,
  ] = await Promise.all([
    r2GetObject({ r2: OBS_R2_CONFIG, key: stationsTableKey }),
    r2GetObject({ r2: OBS_R2_CONFIG, key: timeseriesTableKey }),
    r2GetObject({ r2: OBS_R2_CONFIG, key: phenomenaTableKey }),
    r2GetObject({ r2: OBS_R2_CONFIG, key: observedPropertiesTableKey }),
  ]);

  const stationRows = parseCoreTableRows(
    decodeCoreTableText(stationsObject.body, stationsTableKey),
  )
    .filter((row) => Number(row.connector_id) === connectorId);
  const timeseriesRows = parseCoreTableRows(
    decodeCoreTableText(timeseriesObject.body, timeseriesTableKey),
  )
    .filter((row) => Number(row.connector_id) === connectorId);
  const phenomenonRows = parseCoreTableRows(
    decodeCoreTableText(phenomenaObject.body, phenomenaTableKey),
  )
    .filter((row) => Number(row.connector_id) === connectorId);
  const observedPropertyRows = parseCoreTableRows(
    decodeCoreTableText(
      observedPropertiesObject.body,
      observedPropertiesTableKey,
    ),
  );

  return buildOpenaqSourceLookupFromMetadataRows({
    connectorId,
    stationRows,
    timeseriesRows,
    phenomenonRows,
    observedPropertyRows,
    candidateStationRefs,
  });
}

async function fetchOpenaqSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
): Promise<SourceConnectorLookup> {
  return await fetchMetadataSourceLookupForConnector(
    connectorId,
    candidateStationRefs,
    "openaq",
  );
}

async function fetchUkAirSosSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
): Promise<SourceConnectorLookup> {
  return await fetchMetadataSourceLookupForConnector(
    connectorId,
    candidateStationRefs,
    "uk_air_sos",
  );
}

async function fetchMetadataSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
  adapterLabel: string,
): Promise<SourceConnectorLookup> {
  const cacheKey = connectorId;
  const cached = sourceLookupCache.get(cacheKey);
  if (cached) {
    if (candidateStationRefs.size > 0) {
      for (const stationRef of candidateStationRefs) {
        cached.station_refs.add(stationRef);
      }
    }
    return cached;
  }

  const shouldTryR2Core = SHOULD_USE_R2_CORE_METADATA;
  if (shouldTryR2Core) {
    try {
      const fromR2 = await loadR2CoreOpenaqSourceLookupForConnector(
        connectorId,
        candidateStationRefs,
        adapterLabel,
      );
      if (fromR2 && fromR2.station_refs.size > 0) {
        sourceLookupCache.set(cacheKey, fromR2);
        logStructured("info", "source_lookup_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core",
          station_ref_count: fromR2.station_refs.size,
          timeseries_binding_count: fromR2.binding_by_timeseries_ref.size,
        });
        return fromR2;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("warning", "source_lookup_r2_core_failed", {
        connector_id: connectorId,
        error: message,
      });
    }
  }

  try {
    const fromIngest = await loadIngestOpenaqSourceLookupForConnector(
      connectorId,
      candidateStationRefs,
      adapterLabel,
    );
    if (fromIngest && fromIngest.station_refs.size > 0) {
      sourceLookupCache.set(cacheKey, fromIngest);
      logStructured("info", "source_lookup_resolved", {
        connector_id: connectorId,
        metadata_source: "ingestdb",
        station_ref_count: fromIngest.station_refs.size,
        timeseries_binding_count: fromIngest.binding_by_timeseries_ref.size,
      });
      return fromIngest;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("warning", "source_lookup_ingest_query_failed", {
      connector_id: connectorId,
      error: message,
    });
  }

  const emptyLookup: SourceConnectorLookup = {
    connector_id: connectorId,
    station_refs: new Set(candidateStationRefs),
    binding_by_station_pollutant: new Map<string, SourceTimeseriesBinding>(),
    binding_by_timeseries_id: new Map<number, SourceTimeseriesBinding>(),
    binding_by_timeseries_ref: new Map<string, SourceTimeseriesBinding>(),
    binding_by_timeseries_ref_pollutant: new Map<
      string,
      SourceTimeseriesBinding
    >(),
  };
  return emptyLookup;
}

async function fetchSourceLookupForConnector(
  connectorId: number,
): Promise<SourceConnectorLookup> {
  const cached = sourceLookupCache.get(connectorId);
  if (cached) {
    return cached;
  }

  const shouldTryR2Core = SHOULD_USE_R2_CORE_METADATA;
  if (shouldTryR2Core) {
    try {
      const fromR2 = await loadR2CoreSourceLookupForConnector(connectorId);
      if (fromR2 && fromR2.binding_by_station_pollutant.size > 0) {
        sourceLookupCache.set(connectorId, fromR2);
        logStructured("info", "source_lookup_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core",
          station_ref_count: fromR2.station_refs.size,
          timeseries_binding_count: fromR2.binding_by_station_pollutant.size,
        });
        return fromR2;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("warning", "source_lookup_r2_core_failed", {
        connector_id: connectorId,
        error: message,
      });
    }
  }

  const fromIngest = await loadIngestSourceLookupForConnector(connectorId);
  if (fromIngest && fromIngest.binding_by_station_pollutant.size > 0) {
    sourceLookupCache.set(connectorId, fromIngest);
    logStructured("info", "source_lookup_resolved", {
      connector_id: connectorId,
      metadata_source: "ingestdb",
      station_ref_count: fromIngest.station_refs.size,
      timeseries_binding_count: fromIngest.binding_by_station_pollutant.size,
    });
    return fromIngest;
  }

  throw new Error(
    `Unable to resolve source lookup for connector_id=${connectorId}`,
  );
}

async function fetchObservationHistorySourceLookupForConnector(
  connectorId: number,
): Promise<SourceConnectorLookup> {
  try {
    return await fetchSourceLookupForConnector(connectorId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("info", "source_lookup_retrying_with_metadata_fallback", {
      connector_id: connectorId,
      error: message,
    });

    const stationRefsLookup = await fetchStationRefsForConnector(connectorId);
    const metadataLookup = await fetchMetadataSourceLookupForConnector(
      connectorId,
      stationRefsLookup.station_refs,
      "local_to_aqilevels",
    );

    if (metadataLookup.binding_by_timeseries_id.size > 0) {
      return metadataLookup;
    }

    throw error;
  }
}

async function resolveConnectorIdByCode(
  connectorCodeRaw: string,
): Promise<number | null> {
  const connectorCode = connectorCodeRaw.trim().toLowerCase();
  if (!connectorCode) {
    return null;
  }

  const cached = connectorCodeCache.get(connectorCode);
  if (cached && cached > 0) {
    return cached;
  }

  if (INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY) {
    const query = new URLSearchParams();
    query.set("select", "id");
    query.set("connector_code", `eq.${connectorCode}`);
    query.set("limit", "1");
    const result = await postgrestTable<Array<Record<string, unknown>>>(
      INGEST_SUPABASE_URL,
      INGEST_PRIVILEGED_KEY,
      {
        method: "GET",
        schema: SOURCE_METADATA_SCHEMA,
        table: "connectors",
        query,
      },
    );
    if (!result.error) {
      const rows = Array.isArray(result.data) ? result.data : [];
      const id = Number(rows[0]?.id);
      if (Number.isInteger(id) && id > 0) {
        connectorCodeCache.set(connectorCode, Math.trunc(id));
        return Math.trunc(id);
      }
    }
  }

  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }
  try {
    const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
    if (!snapshotInfo) {
      return null;
    }
    const manifestObject = await r2GetObject({
      r2: OBS_R2_CONFIG,
      key: snapshotInfo.manifest_key,
    });
    const manifest = parseCoreSnapshotManifest(
      new TextDecoder().decode(manifestObject.body),
      snapshotInfo.manifest_key,
    );
    const connectorsTableKey = findCoreTableKey(manifest, "connectors");
    if (!connectorsTableKey) {
      return null;
    }
    const connectorsObject = await r2GetObject({
      r2: OBS_R2_CONFIG,
      key: connectorsTableKey,
    });
    const ndjsonText = decodeCoreTableText(
      connectorsObject.body,
      connectorsTableKey,
    );
    for (const line of ndjsonText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>;
        const rowCode = String(row.connector_code || "").trim().toLowerCase();
        const rowId = Number(row.id);
        if (rowCode === connectorCode && Number.isInteger(rowId) && rowId > 0) {
          connectorCodeCache.set(connectorCode, Math.trunc(rowId));
          return Math.trunc(rowId);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveConnectorServiceUrl(
  connectorId: number,
): Promise<string | null> {
  const cached = connectorServiceUrlCache.get(connectorId);
  if (cached !== undefined) {
    return cached;
  }

  if (INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY) {
    const query = new URLSearchParams();
    query.set("select", "service_url");
    query.set("id", `eq.${connectorId}`);
    query.set("limit", "1");
    const result = await postgrestTable<Array<Record<string, unknown>>>(
      INGEST_SUPABASE_URL,
      INGEST_PRIVILEGED_KEY,
      {
        method: "GET",
        schema: SOURCE_METADATA_SCHEMA,
        table: "connectors",
        query,
      },
    );
    if (!result.error) {
      const serviceUrl = String(result.data?.[0]?.service_url || "").trim();
      if (serviceUrl) {
        connectorServiceUrlCache.set(connectorId, serviceUrl);
        return serviceUrl;
      }
    }
  }

  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    connectorServiceUrlCache.set(connectorId, null);
    return null;
  }

  try {
    const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
    if (!snapshotInfo) {
      connectorServiceUrlCache.set(connectorId, null);
      return null;
    }
    const manifestObject = await r2GetObject({
      r2: OBS_R2_CONFIG,
      key: snapshotInfo.manifest_key,
    });
    const manifest = parseCoreSnapshotManifest(
      new TextDecoder().decode(manifestObject.body),
      snapshotInfo.manifest_key,
    );
    const connectorsTableKey = findCoreTableKey(manifest, "connectors");
    if (!connectorsTableKey) {
      connectorServiceUrlCache.set(connectorId, null);
      return null;
    }
    const connectorsObject = await r2GetObject({
      r2: OBS_R2_CONFIG,
      key: connectorsTableKey,
    });
    const ndjsonText = decodeCoreTableText(
      connectorsObject.body,
      connectorsTableKey,
    );
    for (const line of ndjsonText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>;
        const rowId = Number(row.id);
        if (Number.isInteger(rowId) && rowId === connectorId) {
          const serviceUrl = String(row.service_url || "").trim() || null;
          connectorServiceUrlCache.set(connectorId, serviceUrl);
          return serviceUrl;
        }
      } catch {
        continue;
      }
    }
  } catch {
    connectorServiceUrlCache.set(connectorId, null);
    return null;
  }

  connectorServiceUrlCache.set(connectorId, null);
  return null;
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  retries = SCOMM_ARCHIVE_FETCH_RETRIES,
  retryBaseMs = SCOMM_ARCHIVE_RETRY_BASE_MS,
): Promise<string> {
  let lastErrorMessage = `failed to fetch ${url}`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "uk-aq-backfill-cloud-run",
        },
      });
      if (response.ok) {
        return await response.text();
      }

      const statusMessage = `HTTP ${response.status} for ${url}`;
      lastErrorMessage = statusMessage;
      const canRetry = attempt < retries &&
        (response.status === 408 || isRetryableStatus(response.status));
      if (canRetry) {
        await sleep(Math.min(15000, retryBaseMs * attempt));
        continue;
      }
      throw new Error(statusMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message;
      if (attempt < retries) {
        await sleep(Math.min(15000, retryBaseMs * attempt));
        continue;
      }
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastErrorMessage);
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  retries: number,
  retryBaseMs: number,
): Promise<unknown> {
  let lastErrorMessage = `failed to fetch ${url}`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "uk-aq-backfill-cloud-run",
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      const contentType = (response.headers.get("content-type") || "")
        .toLowerCase();
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);

      if (response.ok) {
        return payload;
      }

      const responseMessage = typeof payload === "string"
        ? payload.trim()
        : asErrorMessage(payload, response.status);
      const statusMessage = responseMessage
        ? `HTTP ${response.status} for ${url}: ${responseMessage}`
        : `HTTP ${response.status} for ${url}`;
      lastErrorMessage = statusMessage;
      const canRetry = attempt < retries &&
        (response.status === 408 || isRetryableStatus(response.status));
      if (canRetry) {
        await sleep(Math.min(15000, retryBaseMs * attempt));
        continue;
      }
      throw new Error(statusMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message;
      if (attempt < retries) {
        await sleep(Math.min(15000, retryBaseMs * attempt));
        continue;
      }
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastErrorMessage);
}

async function fetchBytesWithTimeout(args: {
  url: string;
  timeout_ms: number;
  retries: number;
  retry_base_ms: number;
  allow_not_found?: boolean;
}): Promise<Uint8Array | null> {
  const { url, timeout_ms, retries, retry_base_ms, allow_not_found = false } =
    args;
  let lastErrorMessage = `failed to fetch ${url}`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "uk-aq-backfill-cloud-run",
        },
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
      }
      if (allow_not_found && response.status === 404) {
        return null;
      }

      const statusMessage = `HTTP ${response.status} for ${url}`;
      lastErrorMessage = statusMessage;
      const canRetry = attempt < retries &&
        (response.status === 408 || isRetryableStatus(response.status));
      if (canRetry) {
        await sleep(Math.min(15000, retry_base_ms * attempt));
        continue;
      }
      throw new Error(statusMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message;
      if (attempt < retries) {
        await sleep(Math.min(15000, retry_base_ms * attempt));
        continue;
      }
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastErrorMessage);
}

function ukAirSosMirrorFilePath(
  dayUtc: string,
  timeseriesRef: string,
): string | null {
  if (!IS_LOCAL_RUN || !UK_AIR_SOS_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = UK_AIR_SOS_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(
    root,
    `day_utc=${normalizedDay}`,
    `${encodeURIComponent(timeseriesRef)}.json`,
  );
}

function ukAirSosNoDataManifestFilePath(dayUtc: string): string | null {
  if (!IS_LOCAL_RUN || !UK_AIR_SOS_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = UK_AIR_SOS_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(root, `day_utc=${normalizedDay}`, "_no_data_timeseries.json");
}

function isUkAirSosEmptyPayload(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.length === 0;
  }
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.values)) {
    return record.values.length === 0;
  }
  if (Array.isArray(record.data)) {
    return record.data.length === 0;
  }
  return false;
}

function readUkAirSosNoDataManifest(
  dayUtc: string,
): Map<string, UkAirSosNoDataManifestEntry> {
  const manifestPath = ukAirSosNoDataManifestFilePath(dayUtc);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return new Map();
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`UK-AIR SOS no-data manifest ${manifestPath} is not an object`);
  }
  const manifest = parsed as Record<string, unknown>;
  const timeseriesEntries = Array.isArray(manifest.timeseries)
    ? manifest.timeseries
    : [];
  const entries = new Map<string, UkAirSosNoDataManifestEntry>();
  for (const rawEntry of timeseriesEntries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const timeseriesRef = String(entry.timeseries_ref || "").trim();
    if (!timeseriesRef) {
      continue;
    }
    const stationRef = entry.station_ref == null ? null : String(entry.station_ref);
    const recordedAtUtc = typeof entry.recorded_at_utc === "string" &&
        entry.recorded_at_utc.trim()
      ? entry.recorded_at_utc.trim()
      : nowIso();
    entries.set(timeseriesRef, {
      timeseries_ref: timeseriesRef,
      station_ref: stationRef,
      recorded_at_utc: recordedAtUtc,
    });
  }
  return entries;
}

function writeUkAirSosNoDataManifest(args: {
  day_utc: string;
  entries: Map<string, UkAirSosNoDataManifestEntry>;
}): void {
  const manifestPath = ukAirSosNoDataManifestFilePath(args.day_utc);
  if (!manifestPath) {
    return;
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const payload = {
    schema_version: 1,
    day_utc: parseIsoDayUtc(args.day_utc),
    updated_at_utc: nowIso(),
    timeseries: Array.from(args.entries.values())
      .sort((left, right) => left.timeseries_ref.localeCompare(right.timeseries_ref)),
  };
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

async function fetchUkAirSosTimeseriesData(args: {
  base_url: string;
  day_utc: string;
  timeseries_ref: string;
  timespan: string;
  known_empty_timeseries_refs?: ReadonlySet<string>;
}): Promise<UkAirSosTimeseriesFetchResult> {
  const mirrorPath = ukAirSosMirrorFilePath(
    args.day_utc,
    args.timeseries_ref,
  );
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    try {
      return {
        payload: JSON.parse(fs.readFileSync(mirrorPath, "utf8")) as unknown,
        mirror_reused: true,
        mirror_written: false,
        no_data_manifest_reused: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to parse UK-AIR SOS mirror ${mirrorPath}: ${message}`,
      );
    }
  }

  if (args.known_empty_timeseries_refs?.has(args.timeseries_ref)) {
    return {
      payload: { values: [] },
      mirror_reused: false,
      mirror_written: false,
      no_data_manifest_reused: true,
    };
  }

  const url = new URL(
    `${
      args.base_url.replace(/\/$/, "")
    }/timeseries/${encodeURIComponent(args.timeseries_ref)}/getData`,
  );
  url.searchParams.set("timespan", args.timespan);
  url.searchParams.set("format", "tvp");
  const payload = await fetchJsonWithTimeout(
    url.toString(),
    UK_AIR_SOS_TIMEOUT_MS,
    UK_AIR_SOS_FETCH_RETRIES,
    UK_AIR_SOS_RETRY_BASE_MS,
  );
  const shouldWriteMirror = mirrorPath && shouldWriteUkAirSosMirrorPayload(payload);
  if (shouldWriteMirror) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, JSON.stringify(payload), "utf8");
  }
  return {
    payload,
    mirror_reused: false,
    mirror_written: Boolean(shouldWriteMirror),
    no_data_manifest_reused: false,
  };
}

function shouldWriteUkAirSosMirrorPayload(payload: unknown): boolean {
  return !isUkAirSosEmptyPayload(payload);
}

function parseUkAirSosTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 1e12 ? value * 1000 : value;
    const observedAt = new Date(timestamp);
    return Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const timestamp = numeric < 1e12 ? numeric * 1000 : numeric;
      const observedAt = new Date(timestamp);
      return Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString();
    }
    const observedAt = new Date(trimmed);
    return Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString();
  }
  return null;
}

function parseUkAirSosDatapoints(values: unknown): UkAirSosDatapoint[] {
  let rows = values;
  if (!Array.isArray(rows) && rows && typeof rows === "object") {
    const nested = (rows as Record<string, unknown>).values ||
      (rows as Record<string, unknown>).data;
    if (Array.isArray(nested)) {
      rows = nested;
    }
  }
  if (!Array.isArray(rows)) {
    return [];
  }

  const datapoints: UkAirSosDatapoint[] = [];
  for (const row of rows) {
    let observedAtIso: string | null = null;
    let value: number | null = null;
    let status: string | null = null;

    if (Array.isArray(row)) {
      if (row.length < 2) {
        continue;
      }
      observedAtIso = parseUkAirSosTimestamp(row[0]);
      value = toFiniteNumber(row[1]);
      status = row.length > 2 && row[2] != null ? String(row[2]) : null;
    } else if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      observedAtIso = parseUkAirSosTimestamp(
        record.time ?? record.timestamp ?? record.t ?? record.dateTime ??
          record.phenomenonTime ?? record.observed_at,
      );
      value = toFiniteNumber(record.value ?? record.v ?? record.result);
      status = record.status != null ? String(record.status)
        : record.s != null ? String(record.s)
        : record.quality != null ? String(record.quality)
        : record.qc != null ? String(record.qc)
        : null;
    } else {
      continue;
    }

    if (!observedAtIso) {
      continue;
    }
    datapoints.push({
      observed_at: observedAtIso,
      value,
      status,
    });
  }

  return datapoints;
}

async function processUkAirSosTimeseriesBatch(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
  bindings: SourceTimeseriesBinding[];
  concurrency: number;
  base_url: string;
  timespan: string;
  known_empty_timeseries_refs: ReadonlySet<string>;
  day_start_iso: string;
  day_end_iso: string;
  retry_round?: number;
}): Promise<UkAirSosTimeseriesProcessResult[]> {
  return await mapConcurrent(
    args.bindings,
    args.concurrency,
    async (binding): Promise<UkAirSosTimeseriesProcessResult> => {
      try {
        const payload = await fetchUkAirSosTimeseriesData({
          base_url: args.base_url,
          day_utc: args.day_utc,
          timeseries_ref: binding.timeseries_ref,
          timespan: args.timespan,
          known_empty_timeseries_refs: args.known_empty_timeseries_refs,
        });
        const datapoints = parseUkAirSosDatapoints(payload.payload);
        const rows: SourceObservationRow[] = [];
        let skippedOutsideDay = 0;
        let skippedNullValue = 0;

        for (const datapoint of datapoints) {
          if (
            datapoint.observed_at < args.day_start_iso ||
            datapoint.observed_at >= args.day_end_iso
          ) {
            skippedOutsideDay += 1;
            continue;
          }
          if (datapoint.value === null) {
            skippedNullValue += 1;
            continue;
          }
          rows.push({
            timeseries_id: binding.timeseries_id,
            station_id: binding.station_id,
            pollutant_code: binding.pollutant_code,
            observed_at: datapoint.observed_at,
            value: datapoint.value,
          });
        }

        const emptyPayloadConfirmed = isUkAirSosEmptyPayload(payload.payload);
        logStructured(
          "info",
          "source_to_r2_uk_air_sos_timeseries_processed",
          {
            run_id: args.run_id,
            day_utc: args.day_utc,
            connector_id: args.connector_id,
            source_adapter: "uk_air_sos",
            station_ref: binding.station_ref,
            timeseries_ref: binding.timeseries_ref,
            timeseries_id: binding.timeseries_id,
            pollutant_code: binding.pollutant_code,
            raw_point_count: datapoints.length,
            mapped_point_count: rows.length,
            mirror_reused: payload.mirror_reused,
            mirror_written: payload.mirror_written,
            no_data_manifest_reused: payload.no_data_manifest_reused,
            empty_payload_confirmed: emptyPayloadConfirmed,
            skipped_outside_day: skippedOutsideDay,
            skipped_null_value: skippedNullValue,
            ...(args.retry_round ? { retry_round: args.retry_round } : {}),
          },
        );

        return {
          binding,
          station_ref: binding.station_ref,
          timeseries_ref: binding.timeseries_ref,
          rows,
          raw_point_count: datapoints.length,
          mapped_point_count: rows.length,
          mirror_reused: payload.mirror_reused,
          mirror_written: payload.mirror_written,
          no_data_manifest_reused: payload.no_data_manifest_reused,
          empty_payload_confirmed: emptyPayloadConfirmed,
          skipped_outside_day: skippedOutsideDay,
          skipped_null_value: skippedNullValue,
          error_message: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStructured(
          "warning",
          "source_to_r2_uk_air_sos_timeseries_failed",
          {
            run_id: args.run_id,
            day_utc: args.day_utc,
            connector_id: args.connector_id,
            source_adapter: "uk_air_sos",
            station_ref: binding.station_ref,
            timeseries_ref: binding.timeseries_ref,
            timeseries_id: binding.timeseries_id,
            pollutant_code: binding.pollutant_code,
            error: message,
            ...(args.retry_round ? { retry_round: args.retry_round } : {}),
          },
        );
        return {
          binding,
          station_ref: binding.station_ref,
          timeseries_ref: binding.timeseries_ref,
          rows: [],
          raw_point_count: 0,
          mapped_point_count: 0,
          mirror_reused: false,
          mirror_written: false,
          no_data_manifest_reused: false,
          empty_payload_confirmed: false,
          skipped_outside_day: 0,
          skipped_null_value: 0,
          error_message: `${binding.timeseries_ref} (${binding.station_ref}): ${message}`,
        };
      }
    },
  );
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBreatheLondonSensors(
  payload: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
    payload = payload[0];
  }
  if (Array.isArray(payload)) {
    return payload.filter((row) => row && typeof row === "object") as Record<
      string,
      unknown
    >[];
  }
  return [];
}

function formatBreatheLondonTimestamp(value: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${weekdays[value.getUTCDay()]} ${pad(value.getUTCDate())} ${
    months[value.getUTCMonth()]
  } ${value.getUTCFullYear()} ${pad(value.getUTCHours())}:${
    pad(value.getUTCMinutes())
  }:${pad(value.getUTCSeconds())} GMT`;
}

function parseBreatheLondonObservedAtIso(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  let candidate = text;
  if (candidate.includes(" ") && !candidate.includes("T")) {
    candidate = candidate.replace(" ", "T");
  }
  if (!candidate.endsWith("Z") && !candidate.includes("+")) {
    candidate = `${candidate}Z`;
  }
  const parsedMs = Date.parse(candidate);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

function sanitizeBreatheLondonMirrorSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
}

function breatheLondonMirrorFilePath(
  dayUtc: string,
  siteCode: string,
  species: string,
): string | null {
  if (!BREATHELONDON_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = BREATHELONDON_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(
    root,
    `day_utc=${normalizedDay}`,
    `${sanitizeBreatheLondonMirrorSegment(siteCode)}_${
      sanitizeBreatheLondonMirrorSegment(species)
    }.json`,
  );
}

type BreatheLondonFetchResult = {
  payload: unknown;
  source_url: string;
  mirror_reused: boolean;
  mirror_written: boolean;
};

async function fetchBreatheLondonSensors(): Promise<Record<string, unknown>[]> {
  if (!BREATHELONDON_API_KEY) {
    throw new Error(
      "breathelondon_list_sensors_fetch_failed: missing BREATHELONDON_API_KEY",
    );
  }
  const url = new URL(`${BREATHELONDON_BASE_URL}/ListSensors`);
  url.searchParams.set("key", BREATHELONDON_API_KEY);
  let payload: unknown;
  try {
    payload = await fetchJsonWithTimeout(
      url.toString(),
      BREATHELONDON_TIMEOUT_MS,
      BREATHELONDON_FETCH_RETRIES,
      BREATHELONDON_RETRY_BASE_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`breathelondon_list_sensors_fetch_failed: ${message}`);
  }
  return normalizeBreatheLondonSensors(payload);
}

async function fetchBreatheLondonClarityPayload(args: {
  dayUtc: string;
  siteCode: string;
  species: string;
}): Promise<BreatheLondonFetchResult> {
  const { dayUtc, siteCode, species } = args;
  if (!BREATHELONDON_API_KEY) {
    throw new Error(
      "breathelondon_clarity_fetch_failed: missing BREATHELONDON_API_KEY",
    );
  }
  const dayStart = new Date(utcDayStartIso(dayUtc));
  const dayEnd = new Date(utcDayEndIso(dayUtc));
  const start = encodeURIComponent(formatBreatheLondonTimestamp(dayStart));
  const end = encodeURIComponent(formatBreatheLondonTimestamp(dayEnd));
  const url = new URL(
    `${BREATHELONDON_BASE_URL}/getClarityData/${
      encodeURIComponent(siteCode)
    }/${encodeURIComponent(species)}/${start}/${end}/Hourly`,
  );
  url.searchParams.set("key", BREATHELONDON_API_KEY);
  const mirrorPath = breatheLondonMirrorFilePath(dayUtc, siteCode, species);
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    try {
      const mirroredText = fs.readFileSync(mirrorPath, "utf8");
      return {
        payload: JSON.parse(mirroredText),
        source_url: url.toString(),
        mirror_reused: true,
        mirror_written: false,
      };
    } catch {
      // Ignore unreadable mirror files and refetch from source.
    }
  }

  let payload: unknown;
  try {
    payload = await fetchJsonWithTimeout(
      url.toString(),
      BREATHELONDON_TIMEOUT_MS,
      BREATHELONDON_FETCH_RETRIES,
      BREATHELONDON_RETRY_BASE_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `breathelondon_clarity_fetch_failed: site_code=${siteCode} species=${species} day_utc=${dayUtc}: ${message}`,
    );
  }

  let mirrorWritten = false;
  if (mirrorPath) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, JSON.stringify(payload, null, 2), "utf8");
    mirrorWritten = true;
  }

  return {
    payload,
    source_url: url.toString(),
    mirror_reused: false,
    mirror_written: mirrorWritten,
  };
}

function parseBreatheLondonPayloadObservations(args: {
  dayUtc: string;
  payload: unknown;
  binding: SourceTimeseriesBinding;
}): {
  rows: SourceObservationRow[];
  total_records: number;
  mapped_records: number;
  skipped_outside_day: number;
  skipped_invalid_value_or_timestamp: number;
} {
  const { dayUtc, binding } = args;
  let { payload } = args;
  if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) {
    payload = payload[0];
  }
  if (!Array.isArray(payload)) {
    return {
      rows: [],
      total_records: 0,
      mapped_records: 0,
      skipped_outside_day: 0,
      skipped_invalid_value_or_timestamp: 0,
    };
  }

  const dayStartIso = utcDayStartIso(dayUtc);
  const dayEndIso = utcDayEndIso(dayUtc);
  const rows: SourceObservationRow[] = [];
  let totalRecords = 0;
  let skippedOutsideDay = 0;
  let skippedInvalidValueOrTimestamp = 0;

  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    totalRecords += 1;
    const observedAtIso = parseBreatheLondonObservedAtIso(
      (entry as Record<string, unknown>).DateTime,
    );
    const value = toFiniteNumber((entry as Record<string, unknown>).ScaledValue);
    if (!observedAtIso || value === null) {
      skippedInvalidValueOrTimestamp += 1;
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      skippedOutsideDay += 1;
      continue;
    }
    rows.push({
      timeseries_id: binding.timeseries_id,
      station_id: binding.station_id,
      pollutant_code: binding.pollutant_code,
      observed_at: observedAtIso,
      value,
    });
  }

  return {
    rows,
    total_records: totalRecords,
    mapped_records: rows.length,
    skipped_outside_day: skippedOutsideDay,
    skipped_invalid_value_or_timestamp: skippedInvalidValueOrTimestamp,
  };
}

function parseSensorcommunityStationRefFromFilename(
  fileName: string,
): string | null {
  const match = fileName.match(/_sensor_([0-9]+)\.csv$/i);
  if (!match) {
    return null;
  }
  return match[1];
}

async function fetchSensorcommunityArchiveFileNames(
  dayUtc: string,
): Promise<string[]> {
  const indexUrl = `${SCOMM_ARCHIVE_BASE_URL}/${dayUtc}/`;
  let html: string;
  try {
    html = await fetchTextWithTimeout(
      indexUrl,
      SCOMM_ARCHIVE_TIMEOUT_MS,
      SCOMM_ARCHIVE_FETCH_RETRIES,
      SCOMM_ARCHIVE_RETRY_BASE_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sensorcommunity_archive_index_fetch_failed: ${message}`);
  }
  const files = new Set<string>();
  const pattern = /href="([^"]+\.csv)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const fileName = match[1].trim();
    if (!fileName.startsWith(`${dayUtc}_`)) {
      continue;
    }
    if (!fileName.includes("_sensor_")) {
      continue;
    }
    files.add(fileName);
  }
  return Array.from(files).sort((left, right) => left.localeCompare(right));
}

function sourceMirrorFilePath(dayUtc: string, fileName: string): string | null {
  if (!SCOMM_RAW_MIRROR_ROOT) {
    return null;
  }
  const root = SCOMM_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(root, `day_utc=${dayUtc}`, fileName);
}

async function fetchSensorcommunityArchiveCsv(
  dayUtc: string,
  fileName: string,
): Promise<string> {
  const mirrorPath = sourceMirrorFilePath(dayUtc, fileName);
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    return fs.readFileSync(mirrorPath, "utf8");
  }

  const fileUrl = `${SCOMM_ARCHIVE_BASE_URL}/${dayUtc}/${fileName}`;
  let text: string;
  try {
    text = await fetchTextWithTimeout(
      fileUrl,
      SCOMM_ARCHIVE_TIMEOUT_MS,
      SCOMM_ARCHIVE_FETCH_RETRIES,
      SCOMM_ARCHIVE_RETRY_BASE_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `sensorcommunity_archive_csv_fetch_failed: ${fileName}: ${message}`,
    );
  }

  if (mirrorPath) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, text, "utf8");
  }

  return text;
}

function parseCsvNumber(raw: string): number | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (
    normalized === "nan" || normalized === "null" || normalized === "none" ||
    normalized === "na"
  ) {
    return null;
  }
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseArchiveTimestampToIso(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const hasTimezone = /z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value);
  const parseTarget = hasTimezone ? value : `${value}Z`;
  const parsedMs = Date.parse(parseTarget);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

function parseSensorcommunityCsvObservations(args: {
  dayUtc: string;
  csvText: string;
  lookup: SourceConnectorLookup;
}): SourceObservationRow[] {
  const { dayUtc, csvText, lookup } = args;
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0].split(";").map((header) => header.trim());
  const headerIndex = new Map<string, number>();
  headers.forEach((header, index) => {
    headerIndex.set(header.toLowerCase(), index);
  });

  const sensorIdIndex = headerIndex.get("sensor_id");
  const timestampIndex = headerIndex.get("timestamp");
  if (sensorIdIndex === undefined || timestampIndex === undefined) {
    return [];
  }

  const mappings: Array<
    { header: string; pollutant_code: SourcePollutantCode }
  > = [
    { header: "p1", pollutant_code: "pm10" },
    { header: "p2", pollutant_code: "pm25" },
  ];
  if (SCOMM_INCLUDE_MET_FIELDS) {
    mappings.push(
      { header: "temperature", pollutant_code: "temperature" },
      { header: "humidity", pollutant_code: "humidity" },
      { header: "pressure", pollutant_code: "pressure" },
    );
  }

  const dayStartIso = utcDayStartIso(dayUtc);
  const dayEndIso = utcDayEndIso(dayUtc);
  const rows: SourceObservationRow[] = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const columns = lines[lineIndex].split(";");
    const stationRefRaw = (columns[sensorIdIndex] || "").trim();
    if (!stationRefRaw || !lookup.station_refs.has(stationRefRaw)) {
      continue;
    }

    const observedAtIso = parseArchiveTimestampToIso(
      columns[timestampIndex] || "",
    );
    if (!observedAtIso) {
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      continue;
    }

    for (const mapping of mappings) {
      const valueIndex = headerIndex.get(mapping.header);
      if (valueIndex === undefined) {
        continue;
      }
      const value = parseCsvNumber(columns[valueIndex] || "");
      if (value === null) {
        continue;
      }
      const binding = lookup.binding_by_station_pollutant.get(
        stationPollutantKey(stationRefRaw, mapping.pollutant_code),
      );
      if (!binding) {
        continue;
      }
      rows.push({
        timeseries_id: binding.timeseries_id,
        station_id: binding.station_id,
        pollutant_code: binding.pollutant_code,
        observed_at: observedAtIso,
        value,
      });
    }
  }

  return rows;
}

function buildOpenaqArchiveObjectKey(
  dayUtc: string,
  locationId: number,
): string {
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    throw new Error(`Invalid day_utc for OpenAQ archive key: ${dayUtc}`);
  }
  const year = normalizedDay.slice(0, 4);
  const month = normalizedDay.slice(5, 7);
  const yyyymmdd = normalizedDay.replaceAll("-", "");
  return `records/csv.gz/locationid=${locationId}/year=${year}/month=${month}/location-${locationId}-${yyyymmdd}.csv.gz`;
}

function openaqMirrorFilePath(
  dayUtc: string,
  locationId: number,
): string | null {
  if (!IS_LOCAL_RUN || !OPENAQ_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const yyyymmdd = normalizedDay.replaceAll("-", "");
  const root = OPENAQ_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(
    root,
    `day_utc=${normalizedDay}`,
    `location-${locationId}-${yyyymmdd}.csv.gz`,
  );
}

type OpenaqArchiveFetchResult = {
  found: boolean;
  archive_key: string;
  csv_text: string | null;
  mirror_reused: boolean;
  mirror_written: boolean;
};

async function fetchOpenaqArchiveCsvGz(
  dayUtc: string,
  locationId: number,
): Promise<OpenaqArchiveFetchResult> {
  const archiveKey = buildOpenaqArchiveObjectKey(dayUtc, locationId);
  const mirrorPath = openaqMirrorFilePath(dayUtc, locationId);

  if (mirrorPath && fs.existsSync(mirrorPath)) {
    const mirroredBytes = fs.readFileSync(mirrorPath);
    const mirroredText = new TextDecoder().decode(
      zlib.gunzipSync(mirroredBytes),
    );
    return {
      found: true,
      archive_key: archiveKey,
      csv_text: mirroredText,
      mirror_reused: true,
      mirror_written: false,
    };
  }

  const url = `${OPENAQ_ARCHIVE_BASE_URL}/${archiveKey}`;
  const downloadedBytes = await fetchBytesWithTimeout({
    url,
    timeout_ms: OPENAQ_ARCHIVE_TIMEOUT_MS,
    retries: OPENAQ_ARCHIVE_FETCH_RETRIES,
    retry_base_ms: OPENAQ_ARCHIVE_RETRY_BASE_MS,
    allow_not_found: true,
  });
  if (!downloadedBytes) {
    return {
      found: false,
      archive_key: archiveKey,
      csv_text: null,
      mirror_reused: false,
      mirror_written: false,
    };
  }

  if (mirrorPath) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, downloadedBytes);
  }

  let csvText: string;
  try {
    csvText = new TextDecoder().decode(zlib.gunzipSync(downloadedBytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to decompress OpenAQ archive object ${archiveKey}: ${message}`,
    );
  }

  return {
    found: true,
    archive_key: archiveKey,
    csv_text: csvText,
    mirror_reused: false,
    mirror_written: Boolean(mirrorPath),
  };
}

function parseCsvRow(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function normalizeCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
}

function resolveCsvHeaderIndex(
  headerIndex: Map<string, number>,
  aliases: string[],
): number | null {
  for (const alias of aliases) {
    const index = headerIndex.get(alias);
    if (index !== undefined) {
      return index;
    }
  }
  return null;
}

type OpenaqCsvParseResult = {
  rows: SourceObservationRow[];
  total_records: number;
  mapped_records: number;
  skipped_unknown_binding: number;
  skipped_unknown_parameter: number;
  skipped_outside_day: number;
  skipped_invalid_value_or_timestamp: number;
};

function parseOpenaqCsvObservations(args: {
  dayUtc: string;
  csvText: string;
  lookup: SourceConnectorLookup;
  locationId: number;
  includeMetFields: boolean;
}): OpenaqCsvParseResult {
  const { dayUtc, csvText, lookup, locationId, includeMetFields } = args;
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return {
      rows: [],
      total_records: 0,
      mapped_records: 0,
      skipped_unknown_binding: 0,
      skipped_unknown_parameter: 0,
      skipped_outside_day: 0,
      skipped_invalid_value_or_timestamp: 0,
    };
  }

  const headerValues = parseCsvRow(lines[0], ",").map(normalizeCsvHeader);
  const headerIndex = new Map<string, number>();
  headerValues.forEach((header, index) => headerIndex.set(header, index));

  const locationIdIndex = resolveCsvHeaderIndex(headerIndex, [
    "location_id",
    "locations_id",
    "locationid",
  ]);
  const sensorIdIndex = resolveCsvHeaderIndex(headerIndex, [
    "sensors_id",
    "sensor_id",
    "sensorsid",
    "sensorid",
  ]);
  const datetimeIndex = resolveCsvHeaderIndex(headerIndex, [
    "datetime",
    "timestamp",
    "date_utc",
    "date_local",
  ]);
  const parameterIndex = resolveCsvHeaderIndex(headerIndex, [
    "parameter",
    "pollutant",
  ]);
  const valueIndex = resolveCsvHeaderIndex(headerIndex, [
    "value",
    "measurement",
  ]);
  if (
    locationIdIndex === null ||
    sensorIdIndex === null ||
    datetimeIndex === null ||
    parameterIndex === null ||
    valueIndex === null
  ) {
    return {
      rows: [],
      total_records: 0,
      mapped_records: 0,
      skipped_unknown_binding: 0,
      skipped_unknown_parameter: 0,
      skipped_outside_day: 0,
      skipped_invalid_value_or_timestamp: 0,
    };
  }

  const dayStartIso = utcDayStartIso(dayUtc);
  const dayEndIso = utcDayEndIso(dayUtc);
  const rows: SourceObservationRow[] = [];
  let totalRecords = 0;
  let skippedUnknownBinding = 0;
  let skippedUnknownParameter = 0;
  let skippedOutsideDay = 0;
  let skippedInvalidValueOrTimestamp = 0;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    totalRecords += 1;
    const columns = parseCsvRow(lines[lineIndex], ",");
    const rowLocationRaw = String(columns[locationIdIndex] || "").trim();
    const rowLocationId = Number.parseInt(rowLocationRaw, 10);
    if (!Number.isInteger(rowLocationId) || rowLocationId !== locationId) {
      continue;
    }

    const parameterRaw = String(columns[parameterIndex] || "").trim();
    const pollutantCode = parseSourcePollutantCode(parameterRaw);
    if (!pollutantCode) {
      skippedUnknownParameter += 1;
      continue;
    }
    if (
      !includeMetFields &&
      (pollutantCode === "temperature" || pollutantCode === "humidity" ||
        pollutantCode === "pressure")
    ) {
      continue;
    }

    const observedAtIso = parseArchiveTimestampToIso(
      columns[datetimeIndex] || "",
    );
    const value = parseCsvNumber(columns[valueIndex] || "");
    if (!observedAtIso || value === null) {
      skippedInvalidValueOrTimestamp += 1;
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      skippedOutsideDay += 1;
      continue;
    }

    const sensorRef = String(columns[sensorIdIndex] || "").trim();
    const bySensorPollutant = sensorRef
      ? lookup.binding_by_timeseries_ref_pollutant.get(
        stationPollutantKey(sensorRef, pollutantCode),
      ) || null
      : null;
    const bySensor = sensorRef
      ? lookup.binding_by_timeseries_ref.get(sensorRef) || null
      : null;
    const byStationPollutant = lookup.binding_by_station_pollutant.get(
      stationPollutantKey(String(locationId), pollutantCode),
    ) || null;
    const binding = bySensorPollutant ||
      (bySensor && bySensor.pollutant_code === pollutantCode
        ? bySensor
        : null) ||
      byStationPollutant;
    if (!binding) {
      skippedUnknownBinding += 1;
      continue;
    }

    rows.push({
      timeseries_id: binding.timeseries_id,
      station_id: binding.station_id,
      pollutant_code: binding.pollutant_code,
      observed_at: observedAtIso,
      value,
    });
  }

  return {
    rows,
    total_records: totalRecords,
    mapped_records: rows.length,
    skipped_unknown_binding: skippedUnknownBinding,
    skipped_unknown_parameter: skippedUnknownParameter,
    skipped_outside_day: skippedOutsideDay,
    skipped_invalid_value_or_timestamp: skippedInvalidValueOrTimestamp,
  };
}

function dedupeSourceObservationRows(
  rows: SourceObservationRow[],
): SourceObservationRow[] {
  return dedupeSourceObservationRowsCore(rows) as SourceObservationRow[];
}

function sourceObservationsToObsHistoryRows(
  rows: SourceObservationRow[],
): ObsHistoryRow[] {
  return rows.map((row) => ({
    timeseries_id: row.timeseries_id,
    observed_at: row.observed_at,
    value: row.value,
  }));
}

function sourceObservationsToNarrowRows(
  rows: SourceObservationRow[],
): SourceNarrowRow[] {
  return sourceObservationsToNarrowRowsCore(rows) as SourceNarrowRow[];
}

function helperRowsToAqilevelHistoryRows(
  helperRows: HelperRow[],
): AqilevelsHistoryRow[] {
  return helperRowsToAqilevelHistoryRowsCore(helperRows) as AqilevelsHistoryRow[];
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
    const count = Number.isFinite(countValue)
      ? Math.max(0, Math.trunc(countValue))
      : 0;
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

async function connectorListForDay(
  dayUtc: string,
  ingestCounts: Map<number, number>,
  observsCounts: Map<number, number>,
): Promise<number[]> {
  const connectorIds = new Set(
    connectorListFromCounts(ingestCounts, observsCounts),
  );
  if (ENABLE_R2_FALLBACK && hasRequiredR2Config(OBS_R2_CONFIG)) {
    const r2ConnectorIds = await loadR2ObservationConnectorIdsForDay(dayUtc);
    for (const connectorId of r2ConnectorIds) {
      connectorIds.add(connectorId);
    }
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

  const requestedStationFilter = getStationFilterForConnector(connectorId);
  const requestedStationIds = requestedStationFilter?.station_ids.size
    ? sortedUniquePositiveInts(requestedStationFilter.station_ids)
    : [];
  const requestedStationIdSet = requestedStationIds.length > 0
    ? new Set(requestedStationIds)
    : null;

  const lookup = await fetchSourceLookupForConnector(connectorId);
  const allTimeseriesIds = Array.from(lookup.binding_by_timeseries_id.entries())
    .filter(([, binding]) =>
      requestedStationIdSet
        ? requestedStationIdSet.has(Math.trunc(Number(binding.station_id)))
        : true
    )
    .map(([timeseriesId]) => Math.trunc(Number(timeseriesId)))
    .filter((timeseriesId) => Number.isInteger(timeseriesId) && timeseriesId > 0)
    .sort((left, right) => left - right);

  if (allTimeseriesIds.length === 0) {
    return {
      rows: [],
      source_filter: requestedStationIdSet
        ? "timeseries_ids_station_filter"
        : "timeseries_ids_connector",
    };
  }

  const attempts: Array<{ timeseriesIds: number[]; label: string }> = [];
  if (requestedStationIdSet && requestedStationIdSet.size > 0) {
    attempts.push({
      timeseriesIds: allTimeseriesIds,
      label: "timeseries_ids_station_filter",
    });
  } else {
    attempts.push({
      timeseriesIds: allTimeseriesIds,
      label: "timeseries_ids_connector",
    });
  }

  let lastError = "unknown_source_rpc_error";
  let emptySuccessLabel: string | null = null;
  for (const attempt of attempts) {
    const rows: unknown[] = [];
    let attemptFailed = false;
    let hitMaxPages = false;

    for (const timeseriesChunk of chunkList(
      attempt.timeseriesIds,
      SOURCE_RPC_TIMESERIES_FILTER_CHUNK_SIZE,
    )) {
      let chunkHitMaxPages = true;
      for (let pageIndex = 0; pageIndex < SOURCE_RPC_MAX_PAGES; pageIndex += 1) {
        const query = new URLSearchParams();
        query.set(
          "order",
          "timestamp_hour_utc.asc,timeseries_id.asc,pollutant_code.asc",
        );
        query.set("limit", String(SOURCE_RPC_PAGE_SIZE));
        query.set("offset", String(pageIndex * SOURCE_RPC_PAGE_SIZE));

        const response = await postgrestRpc<unknown>(
          source,
          SOURCE_RPC,
          {
            p_window_start: lookbackStartIso,
            p_window_end: dayEndIso,
            p_timeseries_ids: timeseriesChunk,
          },
          query,
        );
        if (response.error) {
          lastError = response.error.message;
          attemptFailed = true;
          chunkHitMaxPages = false;
          break;
        }

        const pageRows = Array.isArray(response.data) ? response.data : [];
        rows.push(...pageRows);

        if (pageRows.length < SOURCE_RPC_PAGE_SIZE) {
          chunkHitMaxPages = false;
          break;
        }
      }
      if (chunkHitMaxPages) {
        hitMaxPages = true;
      }
      if (attemptFailed) {
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
        timeseries_filter_count: attempt.timeseriesIds.length,
      });
    }

    if (rows.length > 0) {
      return {
        rows,
        source_filter: attempt.label,
      };
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

function toArrayBufferView(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).slice().buffer as ArrayBuffer;
}

async function readParquetColumnValues(
  file: ArrayBuffer,
  metadata: FileMetaData,
  columnName: string,
  rowStart: number,
  rowEnd: number,
): Promise<unknown[]> {
  let rows: unknown[][] = [];
  await parquetRead({
    file,
    metadata,
    columns: [columnName],
    rowStart,
    rowEnd,
    compressors,
    onComplete: (columnRows) => {
      if (Array.isArray(columnRows)) {
        rows = columnRows as unknown[][];
      }
    },
  });
  return rows.map((entry) => Array.isArray(entry) ? entry[0] : undefined);
}

function sortedTimeseriesIdsFromLookup(lookup: SourceConnectorLookup): number[] {
  return Array.from(lookup.binding_by_timeseries_id.keys()).sort((
    left,
    right,
  ) => left - right);
}

function rangeMayContainTimeseriesId(
  sortedTimeseriesIds: number[],
  minTimeseriesId: number,
  maxTimeseriesId: number,
): boolean {
  if (!sortedTimeseriesIds.length) {
    return false;
  }
  let low = 0;
  let high = sortedTimeseriesIds.length - 1;
  while (low <= high) {
    const mid = Math.trunc((low + high) / 2);
    const candidate = sortedTimeseriesIds[mid];
    if (candidate < minTimeseriesId) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (low >= sortedTimeseriesIds.length) {
    return false;
  }
  return sortedTimeseriesIds[low] <= maxTimeseriesId;
}

function parquetKeysFromConnectorManifest(
  manifest: ObsConnectorManifest | null,
): string[] {
  if (!manifest) {
    return [];
  }
  const keys = new Set<string>();
  for (const key of manifest.parquet_object_keys || []) {
    const normalized = String(key || "").trim();
    if (normalized) {
      keys.add(normalized);
    }
  }
  for (const file of manifest.files || []) {
    const normalized = String(file?.key || "").trim();
    if (normalized) {
      keys.add(normalized);
    }
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

async function fetchSourceObservationRowsForConnectorFromR2ObservationHistory(
  connectorId: number,
  lookbackStartIso: string,
  dayEndIso: string,
): Promise<{ rows: SourceObservationRow[]; source_filter: string }> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error(
      "R2 fallback requested but R2 configuration is incomplete",
    );
  }

  const lookup = await fetchObservationHistorySourceLookupForConnector(
    connectorId,
  );
  const requestedStationFilter = getStationFilterForConnector(connectorId);
  const requestedStationIds = requestedStationFilter?.station_ids.size
    ? sortedUniquePositiveInts(requestedStationFilter.station_ids)
    : [];
  const requestedStationIdSet = requestedStationIds.length > 0
    ? new Set(requestedStationIds)
    : null;
  const coveredDays = buildCoveredIsoDaysForUtcRange(
    lookbackStartIso,
    dayEndIso,
  );
  const sortedTimeseriesIds = sortedTimeseriesIdsFromLookup(lookup);
  const mappedRowsRaw: SourceObservationRow[] = [];
  let connectorManifestCount = 0;
  let parquetObjectCount = 0;
  let scannedChunkCount = 0;
  let skippedRowGroupCount = 0;
  let missingConnectorManifestCount = 0;
  let missingParquetObjectCount = 0;

  for (const partitionDayUtc of coveredDays) {
    const connectorManifest = await loadExistingConnectorManifest(
      partitionDayUtc,
      connectorId,
    );
    if (!connectorManifest) {
      missingConnectorManifestCount += 1;
      continue;
    }
    connectorManifestCount += 1;

    const parquetKeys = parquetKeysFromConnectorManifest(connectorManifest);
    for (const parquetKey of parquetKeys) {
      parquetObjectCount += 1;
      let object;
      try {
        object = await r2GetObject({ r2: OBS_R2_CONFIG, key: parquetKey });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        missingParquetObjectCount += 1;
        logStructured(
          "warning",
          "local_to_aqilevels_r2_parquet_object_unavailable",
          {
            connector_id: connectorId,
            partition_day_utc: partitionDayUtc,
            parquet_key: parquetKey,
            error: message,
          },
        );
        continue;
      }

      const file = toArrayBufferView(object.body);
      const metadata = await parquetMetadataAsync(file);
      const schemaColumns = parquetSchema(metadata).children.map((column) =>
        column.element.name
      );
      const timeseriesStatsIndex = schemaColumns.indexOf("timeseries_id");
      if (
        timeseriesStatsIndex < 0 || !schemaColumns.includes("observed_at") ||
        !schemaColumns.includes("value")
      ) {
        logStructured("warning", "local_to_aqilevels_r2_parquet_schema_invalid", {
          connector_id: connectorId,
          partition_day_utc: partitionDayUtc,
          parquet_key: parquetKey,
          columns: schemaColumns,
        });
        continue;
      }

      let rowGroupStart = 0;
      for (const rowGroup of metadata.row_groups ?? []) {
        const rowGroupRows = Number(rowGroup.num_rows ?? 0);
        const rowGroupEnd = rowGroupStart + rowGroupRows;
        if (!Number.isFinite(rowGroupRows) || rowGroupRows <= 0) {
          rowGroupStart = rowGroupEnd;
          continue;
        }

        const stats = rowGroup.columns?.[timeseriesStatsIndex]?.meta_data
          ?.statistics as Record<string, unknown> | undefined;
        const minTimeseriesId = Number(stats?.min_value ?? stats?.min);
        const maxTimeseriesId = Number(stats?.max_value ?? stats?.max);
        if (
          Number.isFinite(minTimeseriesId) && Number.isFinite(maxTimeseriesId) &&
          !rangeMayContainTimeseriesId(
            sortedTimeseriesIds,
            minTimeseriesId,
            maxTimeseriesId,
          )
        ) {
          skippedRowGroupCount += 1;
          rowGroupStart = rowGroupEnd;
          continue;
        }

        for (
          let chunkStart = rowGroupStart;
          chunkStart < rowGroupEnd;
          chunkStart += OBS_R2_PARQUET_ROW_CHUNK_SIZE
        ) {
          const chunkEnd = Math.min(
            rowGroupEnd,
            chunkStart + OBS_R2_PARQUET_ROW_CHUNK_SIZE,
          );
          const [timeseriesValues, observedAtValues, valueValues] =
            await Promise.all([
              readParquetColumnValues(
                file,
                metadata,
                "timeseries_id",
                chunkStart,
                chunkEnd,
              ),
              readParquetColumnValues(
                file,
                metadata,
                "observed_at",
                chunkStart,
                chunkEnd,
              ),
              readParquetColumnValues(
                file,
                metadata,
                "value",
                chunkStart,
                chunkEnd,
              ),
            ]);
          scannedChunkCount += 1;
          const chunkLength = Math.min(
            timeseriesValues.length,
            observedAtValues.length,
            valueValues.length,
          );
          if (!chunkLength) {
            continue;
          }

          const mappedRows = mapR2ObservationRowsToSourceObservations({
            rows: Array.from({ length: chunkLength }, (_, index) => ({
              timeseries_id: timeseriesValues[index],
              observed_at: observedAtValues[index],
              value: valueValues[index],
            })),
            bindingByTimeseriesId: lookup.binding_by_timeseries_id,
            windowStartIso: lookbackStartIso,
            windowEndIso: dayEndIso,
          });
          if (mappedRows.length > 0) {
            const filteredRows = requestedStationIdSet
              ? mappedRows.filter((row) =>
                requestedStationIdSet.has(row.station_id)
              )
              : mappedRows;
            if (filteredRows.length > 0) {
              mappedRowsRaw.push(...filteredRows);
            }
          }
        }

        rowGroupStart = rowGroupEnd;
      }
    }
  }

  const dedupedRows = dedupeSourceObservationRows(mappedRowsRaw);

  logStructured("info", "r2_observation_history_loaded", {
    connector_id: connectorId,
    covered_day_count: coveredDays.length,
    connector_manifest_count: connectorManifestCount,
    missing_connector_manifest_count: missingConnectorManifestCount,
    parquet_object_count: parquetObjectCount,
    missing_parquet_object_count: missingParquetObjectCount,
    scanned_chunk_count: scannedChunkCount,
    skipped_row_group_count: skippedRowGroupCount,
    source_observation_rows_mapped: mappedRowsRaw.length,
    source_observation_rows_deduped: dedupedRows.length,
    station_filter_count: requestedStationIds.length,
  });

  return {
    rows: dedupedRows,
    source_filter: requestedStationIds.length > 0
      ? "r2_observations_history_station_filter"
      : "r2_observations_history",
  };
}

async function fetchSourceRowsForConnectorFromR2ObservationHistory(
  connectorId: number,
  lookbackStartIso: string,
  dayEndIso: string,
): Promise<{ rows: SourceNarrowRow[]; source_filter: string }> {
  const sourceFetch =
    await fetchSourceObservationRowsForConnectorFromR2ObservationHistory(
      connectorId,
      lookbackStartIso,
      dayEndIso,
    );

  return {
    rows: sourceObservationsToNarrowRows(sourceFetch.rows).map((row) => ({
      ...row,
      connector_id: connectorId,
    })),
    source_filter: sourceFetch.source_filter,
  };
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
  let timeseriesHoursChanged = 0;

  const referenceHour = addUtcHours(dayEndIso, -1);
  const lateCutoffHour = addUtcHours(referenceHour, -36);

  for (const chunk of chunkRows(helperRows, HOURLY_UPSERT_CHUNK_SIZE)) {
    const metrics = await upsertAqilevelsChunkWithRetry(
      aqilevelsSource,
      chunk,
      lateCutoffHour,
      referenceHour,
    );
    rowsWritten += metrics.rows_changed;
    timeseriesHoursChanged += metrics.timeseries_hours_changed;
  }

  const timeseriesIds = Array.from(
    new Set(helperRows.map((row) => row.timeseries_id)),
  ).sort((l, r) => l - r);
  const rollupResult = await postgrestRpc<unknown>(
    aqilevelsSource,
    ROLLUP_REFRESH_RPC,
    {
      p_start_hour_utc: dayStartIso,
      p_end_hour_utc: dayEndIso,
      p_timeseries_ids: timeseriesIds,
    },
  );
  if (rollupResult.error) {
    throw new Error(
      `AQI levels rollup refresh RPC failed: ${rollupResult.error.message}`,
    );
  }

  const rollupMetrics = parseRollupMetrics(rollupResult.data);

  logStructured("info", "local_to_aqilevels_chunk_summary", {
    rows_written_aqilevels: rowsWritten,
    timeseries_hours_changed: timeseriesHoursChanged,
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
  const fromDay = parseIsoDayUtc(optionalEnv("UK_AQ_BACKFILL_FROM_DAY_UTC")) ||
    defaults.from_day_utc;
  const toDay = parseIsoDayUtc(optionalEnv("UK_AQ_BACKFILL_TO_DAY_UTC")) ||
    fromDay;

  if (compareIsoDay(toDay, fromDay) < 0) {
    throw new Error(
      "UK_AQ_BACKFILL_TO_DAY_UTC must be >= UK_AQ_BACKFILL_FROM_DAY_UTC",
    );
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
    connector_filter: effectiveConnectorIds,
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
    throw new Error(
      "local_to_aqilevels requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY",
    );
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
      connector_filter: effectiveConnectorIds,
      ingest_retention_days: INGEST_RETENTION_DAYS,
    });

    const ingestCounts = await fetchConnectorCountsForDay(
      "ingestdb",
      dayStartIso,
      dayEndIso,
    );
    const observsCounts = await fetchConnectorCountsForDay(
      "obs_aqidb",
      dayStartIso,
      dayEndIso,
    );

    const connectors = effectiveConnectorIds ||
      await connectorListForDay(dayUtc, ingestCounts, observsCounts);

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

      const existingStatus = await ledgerFetchCheckpointStatus(
        ledgerEnabled,
        dayUtc,
        connectorId,
      );
      const skipDecision = shouldSkipCompletedDay(
        existingStatus,
        FORCE_REPLACE,
      );

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

      try {
        const lookbackStartIso = addUtcHours(dayStartIso, -23);
        const sourceFetch = sourceKind === "r2"
          ? await fetchSourceRowsForConnectorFromR2ObservationHistory(
            connectorId,
            lookbackStartIso,
            dayEndIso,
          )
          : await fetchSourceRowsForConnector(
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

        const status: LocalToAqilevelsDayConnectorResult["status"] = DRY_RUN
          ? "dry_run"
          : "complete";
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

function deriveWindowFromDayList(
  dayUtcList: string[],
): { from_day_utc: string; to_day_utc: string } {
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
    throw new Error(
      "obs_aqi_to_r2 requires OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY",
    );
  }
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error("obs_aqi_to_r2 requires CFLARE_R2_* or R2_* credentials.");
  }

  const requestedDays = buildBackwardDayRange(
    window.from_day_utc,
    window.to_day_utc,
  );
  const initialObservsBackedUpDaySet = await fetchR2BackedUpDaySet(
    requestedDays,
    {
      day_manifest_prefix: OBS_R2_HISTORY_PREFIX,
    },
  );
  const initialAqilevelsBackedUpDaySet = await fetchR2BackedUpDaySet(
    requestedDays,
    {
      day_manifest_prefix: AQI_R2_HISTORY_PREFIX,
    },
  );
  const initialBackedUpDays = requestedDays.filter((dayUtc) =>
    initialObservsBackedUpDaySet.has(dayUtc) &&
    initialAqilevelsBackedUpDaySet.has(dayUtc)
  );
  const observsExecutionDays = FORCE_REPLACE
    ? [...requestedDays]
    : requestedDays.filter((dayUtc) =>
      !initialObservsBackedUpDaySet.has(dayUtc)
    );
  const aqilevelsExecutionDays = FORCE_REPLACE
    ? [...requestedDays]
    : requestedDays.filter((dayUtc) =>
      !initialAqilevelsBackedUpDaySet.has(dayUtc)
    );
  const pendingExecutionDaySet = new Set<string>([
    ...observsExecutionDays,
    ...aqilevelsExecutionDays,
  ]);
  const executionDays = requestedDays.filter((dayUtc) =>
    pendingExecutionDaySet.has(dayUtc)
  );

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
  const hasConnectorFilter = Array.isArray(effectiveConnectorIds) &&
    effectiveConnectorIds.length > 0;

  for (const dayUtc of observsExecutionDays) {
    processedDays.add(dayUtc);
    const hadExistingDayManifest = initialObservsBackedUpDaySet.has(dayUtc);
    const dayStartIso = utcDayStartIso(dayUtc);
    const dayEndIso = utcDayEndIso(dayUtc);

    logStructured("info", "obs_aqi_to_r2_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: effectiveConnectorIds,
      force_replace: FORCE_REPLACE,
    });

    const connectorCounts = await fetchConnectorCountsForDay(
      "obs_aqidb",
      dayStartIso,
      dayEndIso,
    );
    const allSourceConnectors = Array.from(connectorCounts.entries())
      .filter((entry) => entry[1] > 0)
      .map((entry) => entry[0])
      .sort((left, right) => left - right);
    const targetConnectors = (effectiveConnectorIds || allSourceConnectors)
      .slice().sort((left, right) => left - right);
    const targetSet = new Set(targetConnectors);
    const manifestsByConnector = new Map<
      number,
      ObsConnectorManifest & Record<string, unknown>
    >();
    let dayFailed = false;

    if (hasConnectorFilter) {
      const unresolvedConnectorsBeforeExport: number[] = [];
      for (const connectorId of allSourceConnectors) {
        if (targetSet.has(connectorId)) {
          continue;
        }
        const existing = await loadExistingConnectorManifest(
          dayUtc,
          connectorId,
        );
        if (existing) {
          manifestsByConnector.set(connectorId, existing);
        } else {
          unresolvedConnectorsBeforeExport.push(connectorId);
        }
      }
      if (unresolvedConnectorsBeforeExport.length > 0) {
        dayFailed = true;
        summary.failed_days.push(dayUtc);
        await ledgerInsertError(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: null,
          source_kind: "r2",
          error_json: {
            message: "connector_filter_blocked_partial_day_write",
            missing_connectors: unresolvedConnectorsBeforeExport,
          },
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        logStructured(
          "warning",
          "obs_aqi_to_r2_day_skipped_connector_filter_incomplete",
          {
            run_id: runId,
            day_utc: dayUtc,
            target_connectors: targetConnectors,
            missing_connectors: unresolvedConnectorsBeforeExport,
          },
        );
        continue;
      }
    }

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
        error_json: {
          message: "day_manifest_blocked_missing_connector_manifests",
          missing_connectors: unresolvedConnectors,
        },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
    }

    if (!dayFailed) {
      const connectorManifests = Array.from(manifestsByConnector.values()).sort(
        (left, right) => Number(left.connector_id) - Number(right.connector_id),
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
      const manifestHead = await r2HeadObject({
        r2: OBS_R2_CONFIG,
        key: dayManifestKey,
      });
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
      if (!hadExistingDayManifest) {
        try {
          await deleteR2Prefix(buildObsDayPrefix(dayUtc));
          logStructured("info", "obs_aqi_to_r2_day_failed_cleanup_deleted", {
            run_id: runId,
            day_utc: dayUtc,
            domain: "observations",
            day_prefix: buildObsDayPrefix(dayUtc),
          });
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          logStructured("warning", "obs_aqi_to_r2_day_failed_cleanup_error", {
            run_id: runId,
            day_utc: dayUtc,
            domain: "observations",
            error: cleanupMessage,
          });
          await ledgerInsertError(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: null,
            source_kind: "r2",
            error_json: {
              message: "day_failed_cleanup_error",
              domain: "observations",
              error: cleanupMessage,
            },
            started_at: nowIso(),
            finished_at: nowIso(),
          });
        }
      }
    }
  }

  for (const dayUtc of aqilevelsExecutionDays) {
    processedDays.add(dayUtc);
    const hadExistingDayManifest = initialAqilevelsBackedUpDaySet.has(dayUtc);
    const connectorCounts = await fetchAqilevelsConnectorCountsForDay(dayUtc);
    const allSourceConnectors = Array.from(connectorCounts.entries())
      .filter((entry) => entry[1] > 0)
      .map((entry) => entry[0])
      .sort((left, right) => left - right);
    const targetConnectors = (effectiveConnectorIds || allSourceConnectors)
      .slice().sort((left, right) => left - right);
    const targetSet = new Set(targetConnectors);
    const manifestsByConnector = new Map<
      number,
      AqilevelsConnectorManifest & Record<string, unknown>
    >();
    let dayFailed = false;

    if (hasConnectorFilter) {
      const unresolvedConnectorsBeforeExport: number[] = [];
      for (const connectorId of allSourceConnectors) {
        if (targetSet.has(connectorId)) {
          continue;
        }
        const existing = await loadExistingAqiConnectorManifest(
          dayUtc,
          connectorId,
        );
        if (existing) {
          manifestsByConnector.set(connectorId, existing);
        } else {
          unresolvedConnectorsBeforeExport.push(connectorId);
        }
      }
      if (unresolvedConnectorsBeforeExport.length > 0) {
        dayFailed = true;
        summary.failed_days.push(dayUtc);
        await ledgerInsertError(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: null,
          source_kind: "r2",
          error_json: {
            message: "aqilevels_connector_filter_blocked_partial_day_write",
            missing_connectors: unresolvedConnectorsBeforeExport,
          },
          started_at: nowIso(),
          finished_at: nowIso(),
        });
        logStructured(
          "warning",
          "obs_aqi_to_r2_aqilevels_day_skipped_connector_filter_incomplete",
          {
            run_id: runId,
            day_utc: dayUtc,
            target_connectors: targetConnectors,
            missing_connectors: unresolvedConnectorsBeforeExport,
          },
        );
        continue;
      }
    }

    logStructured("info", "obs_aqi_to_r2_aqilevels_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      connector_filter: effectiveConnectorIds,
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
          checkpoint_json: {
            skip_reason: "no_source_rows",
            domain: "aqilevels",
          },
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
          logStructured(
            "warning",
            "obs_aqi_to_r2_aqilevels_connector_row_mismatch",
            {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              expected_rows: expectedRows,
              exported_rows: exportResult.rows_read,
            },
          );
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
      const existing = await loadExistingAqiConnectorManifest(
        dayUtc,
        connectorId,
      );
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
      const connectorManifests = Array.from(manifestsByConnector.values()).sort(
        (left, right) => Number(left.connector_id) - Number(right.connector_id),
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
      const manifestHead = await r2HeadObject({
        r2: OBS_R2_CONFIG,
        key: dayManifestKey,
      });
      if (!manifestHead.exists) {
        throw new Error(
          `Missing AQI day manifest after upload: ${dayManifestKey}`,
        );
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
      if (!hadExistingDayManifest) {
        try {
          await deleteR2Prefix(buildAqiDayPrefix(dayUtc));
          logStructured(
            "info",
            "obs_aqi_to_r2_aqilevels_day_failed_cleanup_deleted",
            {
              run_id: runId,
              day_utc: dayUtc,
              domain: "aqilevels",
              day_prefix: buildAqiDayPrefix(dayUtc),
            },
          );
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          logStructured(
            "warning",
            "obs_aqi_to_r2_aqilevels_day_failed_cleanup_error",
            {
              run_id: runId,
              day_utc: dayUtc,
              domain: "aqilevels",
              error: cleanupMessage,
            },
          );
          await ledgerInsertError(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: null,
            source_kind: "r2",
            error_json: {
              message: "day_failed_cleanup_error",
              domain: "aqilevels",
              error: cleanupMessage,
            },
            started_at: nowIso(),
            finished_at: nowIso(),
          });
        }
      }
    }
  }

  const failedDaySet = new Set(summary.failed_days);
  summary.failed_days = Array.from(failedDaySet).sort(compareIsoDay);
  summary.exported_days = Array.from(new Set(summary.exported_days))
    .filter((dayUtc) => !failedDaySet.has(dayUtc))
    .sort(compareIsoDay);
  summary.days_processed = processedDays.size;

  const finalObservsBackedUpDaySet = await fetchR2BackedUpDaySet(
    requestedDays,
    {
      day_manifest_prefix: OBS_R2_HISTORY_PREFIX,
    },
  );
  const finalAqilevelsBackedUpDaySet = await fetchR2BackedUpDaySet(
    requestedDays,
    {
      day_manifest_prefix: AQI_R2_HISTORY_PREFIX,
    },
  );
  summary.backed_up_days = requestedDays.filter((dayUtc) =>
    finalObservsBackedUpDaySet.has(dayUtc) &&
    finalAqilevelsBackedUpDaySet.has(dayUtc)
  );
  summary.pending_backfill_days = requestedDays.filter((dayUtc) =>
    !(finalObservsBackedUpDaySet.has(dayUtc) &&
      finalAqilevelsBackedUpDaySet.has(dayUtc))
  );
  const backedUpSorted = [...summary.backed_up_days].sort(compareIsoDay);
  summary.min_day_utc = backedUpSorted.length ? backedUpSorted[0] : null;
  summary.max_day_utc = backedUpSorted.length
    ? backedUpSorted[backedUpSorted.length - 1]
    : null;
  if (summary.pending_backfill_days.length > 0) {
    summary.message =
      `obs_aqi_to_r2 completed with ${summary.pending_backfill_days.length} pending day(s).`;
  } else if (
    observsExecutionDays.length === 0 && aqilevelsExecutionDays.length === 0
  ) {
    summary.message =
      "All requested days already had committed observations + aqilevels day manifests in R2.";
  } else {
    summary.message =
      "obs_aqi_to_r2 completed and all requested days now have committed observations + aqilevels day manifests in R2.";
  }

  return summary;
}

async function runR2HistoryObsToAqilevels(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
): Promise<R2HistoryObsToAqilevelsSummary> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error(
      "r2_history_obs_to_aqilevels requires CFLARE_R2_* or R2_* credentials.",
    );
  }

  const requestedDays = buildBackwardDayRange(
    window.from_day_utc,
    window.to_day_utc,
  );
  const observedConnectorIdsByDay = new Map<string, number[]>();
  const discoveredConnectorIds = new Set<number>();

  for (const dayUtc of requestedDays) {
    const connectorIds = await loadR2ObservationConnectorIdsForDay(dayUtc);
    if (!connectorIds.length) {
      continue;
    }
    observedConnectorIdsByDay.set(dayUtc, connectorIds);
    for (const connectorId of connectorIds) {
      discoveredConnectorIds.add(connectorId);
    }
  }

  const discoveredDays = requestedDays.filter((dayUtc) =>
    observedConnectorIdsByDay.has(dayUtc)
  );
  const discoveredConnectorIdList = Array.from(discoveredConnectorIds).sort(
    (left, right) => left - right,
  );
  const hasConnectorFilter = Array.isArray(effectiveConnectorIds) &&
    effectiveConnectorIds.length > 0;
  const processedDays = new Set<string>();

  const summary: R2HistoryObsToAqilevelsSummary = {
    mode: "r2_history_obs_to_aqilevels",
    run_id: runId,
    dry_run: DRY_RUN,
    force_replace: FORCE_REPLACE,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: requestedDays.length,
    days_discovered: discoveredDays.length,
    days_processed: 0,
    connector_day_complete: 0,
    connector_day_skipped: 0,
    connector_day_error: 0,
    rows_read: 0,
    rows_written_aqilevels: 0,
    objects_written_r2: 0,
    objects_deleted_r2: 0,
    parquet_files_written: 0,
    discovered_days: discoveredDays,
    exported_days: [],
    failed_days: [],
    discovered_connector_ids: discoveredConnectorIdList,
    day_connector_results: [],
    message: discoveredDays.length > 0
      ? "Planned AQI rebuild from committed R2 observation history."
      : "No committed R2 observation day manifests were found in the requested window.",
  };

  logStructured("info", "r2_history_obs_to_aqilevels_window_discovered", {
    run_id: runId,
    requested_from_day_utc: window.from_day_utc,
    requested_to_day_utc: window.to_day_utc,
    discovered_days: discoveredDays,
    discovered_day_count: discoveredDays.length,
    discovered_connector_ids: discoveredConnectorIdList,
    connector_filter: effectiveConnectorIds,
    force_replace: FORCE_REPLACE,
  });

  for (const dayUtc of requestedDays) {
    const observedConnectorIds = observedConnectorIdsByDay.get(dayUtc) || [];
    if (!observedConnectorIds.length) {
      continue;
    }

    const targetConnectors = (effectiveConnectorIds || observedConnectorIds)
      .filter((connectorId) => observedConnectorIds.includes(connectorId))
      .sort((left, right) => left - right);
    if (!targetConnectors.length) {
      logStructured("info", "r2_history_obs_to_aqilevels_day_no_target_connectors", {
        run_id: runId,
        day_utc: dayUtc,
        observed_connector_ids: observedConnectorIds,
        connector_filter: effectiveConnectorIds,
      });
      continue;
    }

    processedDays.add(dayUtc);
    const dayManifestKey = buildAqiDayManifestKey(dayUtc);
    const dayManifestHead = await r2HeadObject({
      r2: OBS_R2_CONFIG,
      key: dayManifestKey,
    });
    const hadExistingDayManifest = dayManifestHead.exists;
    const targetConnectorSet = new Set(targetConnectors);
    const nonTargetConnectors = observedConnectorIds.filter((connectorId) =>
      !targetConnectorSet.has(connectorId)
    );
    const unresolvedNonTargetConnectors: number[] = [];
    if (hasConnectorFilter) {
      for (const connectorId of nonTargetConnectors) {
        const existingManifest = await loadExistingAqiConnectorManifest(
          dayUtc,
          connectorId,
        );
        if (!existingManifest) {
          unresolvedNonTargetConnectors.push(connectorId);
        }
      }
    }
    if (unresolvedNonTargetConnectors.length > 0) {
      summary.failed_days.push(dayUtc);
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "r2",
        error_json: {
          message: "connector_filter_blocked_aqilevels_day_refresh",
          missing_connectors: unresolvedNonTargetConnectors,
        },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
      logStructured(
        "warning",
        "r2_history_obs_to_aqilevels_day_skipped_connector_filter_incomplete",
        {
          run_id: runId,
          day_utc: dayUtc,
          target_connectors: targetConnectors,
          missing_connectors: unresolvedNonTargetConnectors,
        },
      );
      continue;
    }

    logStructured("info", "r2_history_obs_to_aqilevels_day_start", {
      run_id: runId,
      day_utc: dayUtc,
      observed_connector_ids: observedConnectorIds,
      target_connectors: targetConnectors,
      force_replace: FORCE_REPLACE,
      dry_run: DRY_RUN,
    });

    let dayFailed = false;
    let dayNeedsManifestRefresh = !hadExistingDayManifest;
    let dayManifestRemovedCount = 0;
    const touchedConnectorIds = new Set<number>();

    for (const connectorId of targetConnectors) {
      const startedAt = nowIso();
      let connectorRowsRead = 0;
      let connectorRowsWritten = 0;
      let connectorObjectsWritten = 0;
      let connectorObjectsDeleted = 0;
      let connectorManifestKey: string | null = null;

      try {
        const existingManifest = await loadExistingAqiConnectorManifest(
          dayUtc,
          connectorId,
        );
        if (existingManifest && !FORCE_REPLACE) {
          summary.connector_day_skipped += 1;
          summary.day_connector_results.push({
            day_utc: dayUtc,
            connector_id: connectorId,
            status: "skipped",
            action: "skip",
            skip_reason: "already_complete",
            rows_read: 0,
            rows_written_aqilevels: 0,
            objects_written_r2: 0,
            objects_deleted_r2: 0,
            manifest_key: existingManifest.manifest_key,
            error: null,
          });

          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "r2",
            status: "skipped",
            rows_read: 0,
            rows_written_aqilevels: 0,
            objects_written_r2: 0,
            checkpoint_json: {
              domain: "aqilevels",
              skip_reason: "already_complete",
              manifest_key: existingManifest.manifest_key,
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          continue;
        }

        const lookbackStartIso = addUtcHours(utcDayStartIso(dayUtc), -23);
        const sourceFetch =
          await fetchSourceObservationRowsForConnectorFromR2ObservationHistory(
            connectorId,
            lookbackStartIso,
            utcDayEndIso(dayUtc),
          );
        connectorRowsRead = sourceFetch.rows.length;
        const aqilevelRows = buildAqilevelHistoryRowsForDayFromSourceObservations(
          sourceFetch.rows,
          dayUtc,
        );
        connectorRowsWritten = aqilevelRows.length;
        const writePlan = planAqilevelHistoryConnectorWrite({
          forceReplace: FORCE_REPLACE,
          hasExistingManifest: Boolean(existingManifest),
          outputRowCount: aqilevelRows.length,
        });
        const writeAction =
          writePlan.action as R2HistoryObsToAqilevelsDayConnectorResult["action"];

        if (DRY_RUN) {
          const status: R2HistoryObsToAqilevelsDayConnectorResult["status"] =
            writeAction === "skip" ? "skipped" : "dry_run";
          summary.rows_read += connectorRowsRead;
          if (status === "skipped") {
            summary.connector_day_skipped += 1;
          } else {
            summary.connector_day_skipped += 1;
          }
          summary.day_connector_results.push({
            day_utc: dayUtc,
            connector_id: connectorId,
            status,
            action: writeAction,
            skip_reason: writePlan.skip_reason,
            rows_read: connectorRowsRead,
            rows_written_aqilevels: connectorRowsWritten,
            objects_written_r2: 0,
            objects_deleted_r2: 0,
            manifest_key: existingManifest?.manifest_key || null,
            error: null,
          });
          logStructured("info", "r2_history_obs_to_aqilevels_connector_dry_run_plan", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            action: writeAction,
            source_filter: sourceFetch.source_filter,
            rows_read: connectorRowsRead,
            rows_candidate_aqilevels: connectorRowsWritten,
            existing_manifest_key: existingManifest?.manifest_key || null,
          });
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "r2",
            status,
            rows_read: connectorRowsRead,
            rows_written_aqilevels: connectorRowsWritten,
            objects_written_r2: 0,
            checkpoint_json: {
              domain: "aqilevels",
              action: writeAction,
              source_filter: sourceFetch.source_filter,
              skip_reason: writePlan.skip_reason,
              existing_manifest_key: existingManifest?.manifest_key || null,
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          continue;
        }

        summary.rows_read += connectorRowsRead;

        if (writePlan.delete_existing) {
          if (!dayManifestRemovedCount && hadExistingDayManifest) {
            dayManifestRemovedCount = await deleteR2ObjectIfExists(
              dayManifestKey,
            );
          }
          connectorObjectsDeleted = await deleteR2Prefix(
            buildAqiConnectorPrefix(dayUtc, connectorId),
          );
          summary.objects_deleted_r2 += connectorObjectsDeleted;
          touchedConnectorIds.add(connectorId);
          dayNeedsManifestRefresh = true;
        }

        if (writePlan.write_connector_manifest) {
          const exportResult = await exportAqiConnectorRowsToR2({
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            rows: aqilevelRows,
            force_replace: false,
          });
          connectorObjectsWritten = exportResult.objects_written_r2;
          connectorManifestKey = exportResult.manifest_key;
          summary.objects_written_r2 += exportResult.objects_written_r2;
          summary.parquet_files_written += exportResult.parquet_files_written;
          touchedConnectorIds.add(connectorId);
          dayNeedsManifestRefresh = true;
        }

        summary.rows_written_aqilevels += connectorRowsWritten;
        summary.connector_day_complete += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "complete",
          action: writeAction,
          skip_reason: writePlan.skip_reason,
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          objects_deleted_r2: connectorObjectsDeleted,
          manifest_key: connectorManifestKey,
          error: null,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "complete",
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          checkpoint_json: {
            domain: "aqilevels",
            action: writeAction,
            source_filter: sourceFetch.source_filter,
            manifest_key: connectorManifestKey,
            objects_deleted_r2: connectorObjectsDeleted,
            completed_at: nowIso(),
          },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "complete",
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          checkpoint_json: {
            domain: "aqilevels",
            action: writeAction,
            updated_by_run_id: runId,
            manifest_key: connectorManifestKey,
            objects_deleted_r2: connectorObjectsDeleted,
            completed_at: nowIso(),
          },
          updated_at: nowIso(),
        });

        logStructured("info", "r2_history_obs_to_aqilevels_connector_complete", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          action: writeAction,
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          objects_deleted_r2: connectorObjectsDeleted,
          manifest_key: connectorManifestKey,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dayFailed = true;
        summary.connector_day_error += 1;
        summary.day_connector_results.push({
          day_utc: dayUtc,
          connector_id: connectorId,
          status: "error",
          action: FORCE_REPLACE ? "replace" : "write",
          skip_reason: null,
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          objects_deleted_r2: connectorObjectsDeleted,
          manifest_key: connectorManifestKey,
          error: message,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "error",
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          error_json: { message, domain: "aqilevels" },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "r2",
          status: "error",
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          checkpoint_json: {
            domain: "aqilevels",
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
          source_kind: "r2",
          error_json: { message, domain: "aqilevels" },
          started_at: startedAt,
          finished_at: nowIso(),
        });

        logStructured("error", "r2_history_obs_to_aqilevels_connector_failed", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          rows_read: connectorRowsRead,
          rows_written_aqilevels: connectorRowsWritten,
          objects_written_r2: connectorObjectsWritten,
          objects_deleted_r2: connectorObjectsDeleted,
          error: message,
        });
      }
    }

    if (DRY_RUN) {
      continue;
    }

    summary.objects_deleted_r2 += dayManifestRemovedCount;

    if (dayFailed) {
      summary.failed_days.push(dayUtc);
      for (const connectorId of touchedConnectorIds) {
        try {
          const deleted = await deleteR2Prefix(
            buildAqiConnectorPrefix(dayUtc, connectorId),
          );
          if (deleted > 0) {
            summary.objects_deleted_r2 += deleted;
          }
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          logStructured(
            "warning",
            "r2_history_obs_to_aqilevels_day_failed_cleanup_error",
            {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              error: cleanupMessage,
            },
          );
        }
      }
      continue;
    }
    if (!dayNeedsManifestRefresh) {
      continue;
    }

    const connectorManifests = await loadAllAqiConnectorManifestsForDay(dayUtc);
    const connectorManifestIds = new Set(
      connectorManifests.map((manifest) => Number(manifest.connector_id)),
    );
    const unresolvedNonTargetAfterRefresh = hasConnectorFilter
      ? nonTargetConnectors.filter((connectorId) =>
        !connectorManifestIds.has(connectorId)
      )
      : [];
    if (unresolvedNonTargetAfterRefresh.length > 0) {
      summary.failed_days.push(dayUtc);
      await ledgerInsertError(ledgerEnabled, {
        run_id: runId,
        run_mode: RUN_MODE,
        day_utc: dayUtc,
        connector_id: null,
        source_kind: "r2",
        error_json: {
          message: "aqilevels_day_manifest_blocked_missing_connector_manifests",
          missing_connectors: unresolvedNonTargetAfterRefresh,
        },
        started_at: nowIso(),
        finished_at: nowIso(),
      });
      logStructured(
        "warning",
        "r2_history_obs_to_aqilevels_day_failed",
        {
          run_id: runId,
          day_utc: dayUtc,
          unresolved_connectors: unresolvedNonTargetAfterRefresh,
        },
      );
      continue;
    }

    if (!connectorManifests.length) {
      summary.exported_days.push(dayUtc);
      logStructured("info", "r2_history_obs_to_aqilevels_day_complete", {
        run_id: runId,
        day_utc: dayUtc,
        connector_count: 0,
        day_manifest_written: false,
        existing_aqilevel_objects_removed: dayManifestRemovedCount,
      });
      continue;
    }

    const dayManifest = createAqiDayManifest({
      dayUtc,
      runId,
      connectorManifests,
      writerGitSha: OBS_R2_WRITER_GIT_SHA,
      backedUpAtUtc: nowIso(),
    });
    await r2PutObject({
      r2: OBS_R2_CONFIG,
      key: dayManifestKey,
      body: encodeJsonBody(dayManifest),
      content_type: "application/json",
    });
    const manifestHead = await r2HeadObject({
      r2: OBS_R2_CONFIG,
      key: dayManifestKey,
    });
    if (!manifestHead.exists) {
      throw new Error(
        `Missing AQI day manifest after upload: ${dayManifestKey}`,
      );
    }
    summary.objects_written_r2 += 1;
    summary.exported_days.push(dayUtc);
    logStructured("info", "r2_history_obs_to_aqilevels_day_complete", {
      run_id: runId,
      day_utc: dayUtc,
      connector_count: connectorManifests.length,
      day_manifest_key: dayManifestKey,
      existing_aqilevel_objects_removed: dayManifestRemovedCount,
    });
  }

  const failedDaySet = new Set(summary.failed_days);
  summary.failed_days = Array.from(failedDaySet).sort(compareIsoDay);
  summary.exported_days = Array.from(new Set(summary.exported_days))
    .filter((dayUtc) => !failedDaySet.has(dayUtc))
    .sort(compareIsoDay);
  summary.days_processed = processedDays.size;
  if (summary.failed_days.length > 0) {
    summary.message =
      `r2_history_obs_to_aqilevels completed with ${summary.failed_days.length} failed day(s).`;
  } else if (!summary.exported_days.length && discoveredDays.length === 0) {
    summary.message =
      "No committed R2 observation day manifests were found in the requested window.";
  } else if (!summary.exported_days.length) {
    summary.message =
      "r2_history_obs_to_aqilevels completed with no AQI manifest changes.";
  } else {
    summary.message =
      "r2_history_obs_to_aqilevels completed and refreshed committed AQI history manifests from R2 observations.";
  }

  return summary;
}

function sourceObservationRowsToHelperRowsForDay(
  rows: SourceObservationRow[],
  dayUtc: string,
): HelperRow[] {
  return sourceObservationRowsToHelperRowsForDayCore(rows, dayUtc) as HelperRow[];
}

async function runSourceToAll(
  runId: string,
  window: { from_day_utc: string; to_day_utc: string },
  ledgerEnabled: boolean,
): Promise<SourceToAllSummary> {
  if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error("source_to_r2 requires CFLARE_R2_* or R2_* credentials.");
  }

  const retentionWindow = computeRollingLocalRetentionWindow({
    nowUtc: new Date(),
    timeZone: LOCAL_TIMEZONE,
    localRetentionDays: OBS_AQI_LOCAL_RETENTION_DAYS,
  });
  const requestedDays = buildBackwardDayRange(
    window.from_day_utc,
    window.to_day_utc,
  );
  const warnings: string[] = [];
  const sourceAcquisitionPendingDaySet = new Set<string>();
  const sourceProcessedDaySet = new Set<string>();
  const sourceFailedDaySet = new Set<string>();
  const sourceAdapterByConnectorId = new Map<number, SourceAdapterKind>();
  let cachedBreatheLondonSensors: Record<string, unknown>[] | null = null;

  if (BREATHELONDON_SOURCE_ENABLED) {
    if (!BREATHELONDON_API_KEY) {
      warnings.push(
        "Breathe London source adapter enabled, but BREATHELONDON_API_KEY is missing; skipping Breathe London source adapter.",
      );
    } else {
      const resolvedBreatheLondonConnectorId = await resolveConnectorIdByCode(
        BREATHELONDON_CONNECTOR_CODE,
      );
      let breatheLondonConnectorId: number | null = null;
      if (resolvedBreatheLondonConnectorId) {
        breatheLondonConnectorId = resolvedBreatheLondonConnectorId;
      } else if (
        Number.isInteger(BREATHELONDON_CONNECTOR_ID_FALLBACK) &&
        BREATHELONDON_CONNECTOR_ID_FALLBACK > 0
      ) {
        breatheLondonConnectorId = BREATHELONDON_CONNECTOR_ID_FALLBACK;
        warnings.push(
          `Could not resolve connector_code=${BREATHELONDON_CONNECTOR_CODE}; using fallback connector_id=${BREATHELONDON_CONNECTOR_ID_FALLBACK}.`,
        );
      } else {
        warnings.push(
          `Breathe London source adapter enabled, but connector_id could not be resolved from connector_code=${BREATHELONDON_CONNECTOR_CODE}; skipping Breathe London source adapter.`,
        );
      }
      if (breatheLondonConnectorId) {
        sourceAdapterByConnectorId.set(
          breatheLondonConnectorId,
          "breathelondon",
        );
      }
    }
  } else {
    warnings.push(
      "Breathe London source adapter is disabled by UK_AQ_BACKFILL_BREATHELONDON_SOURCE_ENABLED=false.",
    );
  }

  if (UK_AIR_SOS_SOURCE_ENABLED) {
    const resolvedUkAirSosConnectorId = await resolveConnectorIdByCode(
      UK_AIR_SOS_CONNECTOR_CODE,
    );
    let ukAirSosConnectorId: number | null = null;
    if (resolvedUkAirSosConnectorId) {
      ukAirSosConnectorId = resolvedUkAirSosConnectorId;
    } else if (
      Number.isInteger(UK_AIR_SOS_CONNECTOR_ID_FALLBACK) &&
      UK_AIR_SOS_CONNECTOR_ID_FALLBACK > 0
    ) {
      ukAirSosConnectorId = UK_AIR_SOS_CONNECTOR_ID_FALLBACK;
      warnings.push(
        `Could not resolve connector_code=${UK_AIR_SOS_CONNECTOR_CODE}; using fallback connector_id=${UK_AIR_SOS_CONNECTOR_ID_FALLBACK}.`,
      );
    } else {
      warnings.push(
        `UK-AIR SOS source adapter enabled, but connector_id could not be resolved from connector_code=${UK_AIR_SOS_CONNECTOR_CODE}; skipping UK-AIR SOS source adapter.`,
      );
    }
    if (ukAirSosConnectorId) {
      sourceAdapterByConnectorId.set(ukAirSosConnectorId, "uk_air_sos");
    }
  } else {
    warnings.push(
      "UK-AIR SOS source adapter is disabled by UK_AQ_BACKFILL_UK_AIR_SOS_SOURCE_ENABLED=false.",
    );
  }

  if (SCOMM_SOURCE_ENABLED) {
    const resolvedSensorcommunityConnectorId = await resolveConnectorIdByCode(
      SCOMM_CONNECTOR_CODE,
    );
    const sensorcommunityConnectorId = resolvedSensorcommunityConnectorId || 7;
    if (!resolvedSensorcommunityConnectorId) {
      warnings.push(
        `Could not resolve connector_code=${SCOMM_CONNECTOR_CODE} from core metadata; using fallback connector_id=7.`,
      );
    }
    sourceAdapterByConnectorId.set(
      sensorcommunityConnectorId,
      "sensorcommunity",
    );
  } else {
    warnings.push(
      "Sensor.Community source adapter is disabled by UK_AQ_BACKFILL_SCOMM_SOURCE_ENABLED=false.",
    );
  }

  if (OPENAQ_SOURCE_ENABLED) {
    const resolvedOpenaqConnectorId = await resolveConnectorIdByCode(
      OPENAQ_CONNECTOR_CODE,
    );
    let openaqConnectorId: number | null = null;
    if (resolvedOpenaqConnectorId) {
      openaqConnectorId = resolvedOpenaqConnectorId;
    } else if (
      Number.isInteger(OPENAQ_CONNECTOR_ID_FALLBACK) &&
      OPENAQ_CONNECTOR_ID_FALLBACK > 0
    ) {
      openaqConnectorId = OPENAQ_CONNECTOR_ID_FALLBACK;
      warnings.push(
        `Could not resolve connector_code=${OPENAQ_CONNECTOR_CODE}; using fallback connector_id=${OPENAQ_CONNECTOR_ID_FALLBACK}.`,
      );
    } else {
      warnings.push(
        `OpenAQ source adapter enabled, but connector_id could not be resolved from connector_code=${OPENAQ_CONNECTOR_CODE}; skipping OpenAQ source adapter.`,
      );
    }
    if (openaqConnectorId) {
      sourceAdapterByConnectorId.set(openaqConnectorId, "openaq");
    }
  } else {
    warnings.push(
      "OpenAQ source adapter is disabled by UK_AQ_BACKFILL_OPENAQ_SOURCE_ENABLED=false.",
    );
  }

  const defaultConnectors = Array.from(sourceAdapterByConnectorId.keys()).sort((
    left,
    right,
  ) => left - right);
  const targetConnectors =
    (effectiveConnectorIds && effectiveConnectorIds.length > 0)
      ? [...effectiveConnectorIds].sort((left, right) => left - right)
      : defaultConnectors;
  const sourceConnectors = targetConnectors.filter((connectorId) =>
    sourceAdapterByConnectorId.has(connectorId)
  );
  const unsupportedConnectors = targetConnectors.filter((connectorId) =>
    !sourceAdapterByConnectorId.has(connectorId)
  );
  if (unsupportedConnectors.length > 0) {
    warnings.push(
      `source_to_r2 currently supports connector(s): ${
        defaultConnectors.length ? defaultConnectors.join(", ") : "(none)"
      }; unsupported connector(s): ${unsupportedConnectors.join(", ")}.`,
    );
    for (const dayUtc of requestedDays) {
      sourceAcquisitionPendingDaySet.add(dayUtc);
    }
  }
  if (sourceConnectors.length === 0) {
    warnings.push(
      "No source adapters available for the requested connector filter.",
    );
    for (const dayUtc of requestedDays) {
      sourceAcquisitionPendingDaySet.add(dayUtc);
    }
  }

  let rowsRead = 0;
  let rowsWrittenAqilevels = 0;
  let objectsWrittenR2 = 0;
  let connectorDayComplete = 0;
  let connectorDaySkipped = 0;
  let connectorDayError = 0;
  const sensorcommunityArchiveIndexByDay = new Map<string, string[]>();

  for (const dayUtc of requestedDays) {
    if (!sourceConnectors.length) {
      continue;
    }

    for (const connectorId of sourceConnectors) {
      const startedAt = nowIso();
      const sourceAdapter = sourceAdapterByConnectorId.get(connectorId);
      if (!sourceAdapter) {
        continue;
      }

      try {
        const existingObsManifest = await loadExistingConnectorManifest(
          dayUtc,
          connectorId,
        );
        const existingAqiManifest = await loadExistingAqiConnectorManifest(
          dayUtc,
          connectorId,
        );
        if (!FORCE_REPLACE && existingObsManifest && existingAqiManifest) {
          connectorDaySkipped += 1;
          logStructured("info", "source_to_r2_connector_day_skipped_existing", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: sourceAdapter,
            skip_reason: "already_backed_up",
          });
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "r2",
            status: "skipped",
            rows_read: 0,
            rows_written_aqilevels: 0,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              skip_reason: "already_backed_up",
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          continue;
        }

        const observationRowsRaw: SourceObservationRow[] = [];
        const sourceCheckpointJson: Record<string, unknown> = {
          source_adapter: sourceAdapter,
        };
        let candidateSourceUnits = 0;

        if (sourceAdapter === "breathelondon") {
          const lookup = await fetchSourceLookupForConnector(connectorId);
          const requestedStationRefs = getStationFilterForConnector(connectorId)
            ?.station_refs;
          if (!cachedBreatheLondonSensors) {
            cachedBreatheLondonSensors = await fetchBreatheLondonSensors();
          }

          const candidateSites = Array.from(
            new Map(
              cachedBreatheLondonSensors.map((sensor) => {
                const siteCode = String(sensor.SiteCode || "").trim();
                return [siteCode, sensor] as const;
              }).filter(([siteCode]) => Boolean(siteCode)),
            ).entries(),
          )
            .map(([siteCode, sensor]) => ({
              site_code: siteCode,
              sensor,
            }))
            .filter(({ site_code }) => lookup.station_refs.has(site_code))
            .filter(({ site_code }) =>
              requestedStationRefs?.size ? requestedStationRefs.has(site_code) : true
            )
            .sort((left, right) => left.site_code.localeCompare(right.site_code));

          if (candidateSites.length === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: requestedStationRefs?.size
                  ? "no_matching_site_codes"
                  : "no_candidate_site_codes",
                sensor_count: cachedBreatheLondonSensors.length,
                lookup_station_ref_count: lookup.station_refs.size,
                requested_station_ref_count: requestedStationRefs?.size || null,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          let skippedUnknownBinding = 0;
          const candidateRequests: Array<{
            site_code: string;
            species: string;
            binding: SourceTimeseriesBinding;
          }> = [];
          for (const candidateSite of candidateSites) {
            for (const speciesConfig of BREATHELONDON_SOURCE_SPECIES) {
              const binding = lookup.binding_by_station_pollutant.get(
                stationPollutantKey(
                  candidateSite.site_code,
                  speciesConfig.pollutant_code,
                ),
              ) || lookup.binding_by_timeseries_ref.get(
                `${candidateSite.site_code}:${speciesConfig.species}`,
              ) || null;
              if (!binding) {
                skippedUnknownBinding += 1;
                continue;
              }
              candidateRequests.push({
                site_code: candidateSite.site_code,
                species: speciesConfig.species,
                binding,
              });
            }
          }

          if (candidateRequests.length === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: "no_matching_timeseries_bindings",
                candidate_site_count: candidateSites.length,
                skipped_unknown_binding: skippedUnknownBinding,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          let totalMirrorReused = 0;
          let totalMirrorWritten = 0;
          let totalRawRecords = 0;
          let totalMappedRecords = 0;
          let totalSkippedOutsideDay = 0;
          let totalSkippedInvalidValueOrTimestamp = 0;

          for (const request of candidateRequests) {
            const sourceFile = await fetchBreatheLondonClarityPayload({
              dayUtc,
              siteCode: request.site_code,
              species: request.species,
            });
            if (sourceFile.mirror_reused) {
              totalMirrorReused += 1;
            }
            if (sourceFile.mirror_written) {
              totalMirrorWritten += 1;
            }

            const parsed = parseBreatheLondonPayloadObservations({
              dayUtc,
              payload: sourceFile.payload,
              binding: request.binding,
            });
            observationRowsRaw.push(...parsed.rows);
            totalRawRecords += parsed.total_records;
            totalMappedRecords += parsed.mapped_records;
            totalSkippedOutsideDay += parsed.skipped_outside_day;
            totalSkippedInvalidValueOrTimestamp +=
              parsed.skipped_invalid_value_or_timestamp;

            logStructured(
              "info",
              "source_to_r2_breathelondon_site_species_processed",
              {
                run_id: runId,
                day_utc: dayUtc,
                connector_id: connectorId,
                source_adapter: "breathelondon",
                site_code: request.site_code,
                species: request.species,
                source_url: sourceFile.source_url,
                mirror_reused: sourceFile.mirror_reused,
                mirror_written: sourceFile.mirror_written,
                raw_records: parsed.total_records,
                mapped_records: parsed.mapped_records,
                skipped_outside_day: parsed.skipped_outside_day,
                skipped_invalid_value_or_timestamp:
                  parsed.skipped_invalid_value_or_timestamp,
              },
            );
          }

          candidateSourceUnits = candidateSites.length;
          sourceCheckpointJson.source_base_url = BREATHELONDON_BASE_URL;
          sourceCheckpointJson.sensor_count = cachedBreatheLondonSensors.length;
          sourceCheckpointJson.candidate_site_count = candidateSites.length;
          sourceCheckpointJson.candidate_request_count =
            candidateRequests.length;
          sourceCheckpointJson.mirror_reused_count = totalMirrorReused;
          sourceCheckpointJson.mirror_written_count = totalMirrorWritten;
          sourceCheckpointJson.total_raw_records = totalRawRecords;
          sourceCheckpointJson.total_mapped_records = totalMappedRecords;
          sourceCheckpointJson.total_skipped_unknown_binding =
            skippedUnknownBinding;
          sourceCheckpointJson.total_skipped_outside_day =
            totalSkippedOutsideDay;
          sourceCheckpointJson.total_skipped_invalid_value_or_timestamp =
            totalSkippedInvalidValueOrTimestamp;
        } else if (sourceAdapter === "sensorcommunity") {
          let archiveFileNames = sensorcommunityArchiveIndexByDay.get(dayUtc) ||
            null;
          if (!archiveFileNames) {
            archiveFileNames = await fetchSensorcommunityArchiveFileNames(
              dayUtc,
            );
            sensorcommunityArchiveIndexByDay.set(dayUtc, archiveFileNames);
          }

          const lookup = await fetchSourceLookupForConnector(connectorId);
          const requestedStationRefs = getStationFilterForConnector(connectorId)
            ?.station_refs;
          const unknownStationRefs = new Set<string>();
          const candidateFiles: string[] = [];
          for (const fileName of archiveFileNames) {
            const stationRef = parseSensorcommunityStationRefFromFilename(
              fileName,
            );
            if (!stationRef) {
              continue;
            }
            if (!lookup.station_refs.has(stationRef)) {
              unknownStationRefs.add(stationRef);
              continue;
            }
            if (
              requestedStationRefs?.size &&
              !requestedStationRefs.has(stationRef)
            ) {
              continue;
            }
            candidateFiles.push(fileName);
          }

          if (unknownStationRefs.size > 0) {
            logStructured(
              "warning",
              "source_to_r2_sensorcommunity_unknown_station_refs",
              {
                run_id: runId,
                day_utc: dayUtc,
                connector_id: connectorId,
                unknown_station_ref_count: unknownStationRefs.size,
                unknown_station_ref_sample: Array.from(unknownStationRefs)
                  .slice(0, 10),
              },
            );
          }

          if (candidateFiles.length === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: "no_matching_station_refs",
                station_ref_count: lookup.station_refs.size,
                requested_station_ref_count: requestedStationRefs?.size || null,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          for (const fileName of candidateFiles) {
            const csvText = await fetchSensorcommunityArchiveCsv(
              dayUtc,
              fileName,
            );
            const parsedRows = parseSensorcommunityCsvObservations({
              dayUtc,
              csvText,
              lookup,
            });
            observationRowsRaw.push(...parsedRows);
          }
          candidateSourceUnits = candidateFiles.length;
          sourceCheckpointJson.candidate_files = candidateFiles.length;
        } else if (sourceAdapter === "openaq") {
          const stationRefsLookup = await fetchStationRefsForConnector(
            connectorId,
          );
          const requestedStationRefs = getStationFilterForConnector(connectorId)
            ?.station_refs;
          const candidateStationRefs = requestedStationRefs?.size
            ? new Set(
              Array.from(stationRefsLookup.station_refs).filter((stationRef) =>
                requestedStationRefs.has(stationRef)
              ),
            )
            : stationRefsLookup.station_refs;
          if (candidateStationRefs.size === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: stationRefsLookup.station_refs.size === 0
                  ? "no_candidate_station_refs"
                  : "no_matching_station_refs",
                station_ref_count: stationRefsLookup.station_refs.size,
                requested_station_ref_count: requestedStationRefs?.size || null,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          const locationIdSet = new Set<number>();
          for (const stationRef of candidateStationRefs) {
            const locationId = Number.parseInt(stationRef, 10);
            if (Number.isInteger(locationId) && locationId > 0) {
              locationIdSet.add(locationId);
            }
          }
          const candidateLocationIds = Array.from(locationIdSet).sort((
            left,
            right,
          ) => left - right);
          if (candidateLocationIds.length === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: "no_numeric_location_ids_from_station_refs",
                station_ref_count: candidateStationRefs.size,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          const lookup = await fetchOpenaqSourceLookupForConnector(
            connectorId,
            candidateStationRefs,
          );
          let locationFilesFound = 0;
          let locationFilesMissing = 0;
          let locationFilesMirrorReused = 0;
          let locationFilesMirrorWritten = 0;
          let totalCsvRecords = 0;
          let totalMappedRecords = 0;
          let totalSkippedUnknownBinding = 0;
          let totalSkippedUnknownParameter = 0;
          let totalSkippedOutsideDay = 0;
          let totalSkippedInvalidValueOrTimestamp = 0;

          for (const locationId of candidateLocationIds) {
            const sourceFile = await fetchOpenaqArchiveCsvGz(
              dayUtc,
              locationId,
            );
            if (!sourceFile.found || !sourceFile.csv_text) {
              locationFilesMissing += 1;
              logStructured(
                "info",
                "source_to_r2_openaq_location_source_missing",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: "openaq",
                  location_id: locationId,
                  archive_key: sourceFile.archive_key,
                  source_found: false,
                },
              );
              continue;
            }

            locationFilesFound += 1;
            if (sourceFile.mirror_reused) {
              locationFilesMirrorReused += 1;
            }
            if (sourceFile.mirror_written) {
              locationFilesMirrorWritten += 1;
            }

            const parsed = parseOpenaqCsvObservations({
              dayUtc,
              csvText: sourceFile.csv_text,
              lookup,
              locationId,
              includeMetFields: OPENAQ_INCLUDE_MET_FIELDS,
            });
            observationRowsRaw.push(...parsed.rows);
            totalCsvRecords += parsed.total_records;
            totalMappedRecords += parsed.mapped_records;
            totalSkippedUnknownBinding += parsed.skipped_unknown_binding;
            totalSkippedUnknownParameter += parsed.skipped_unknown_parameter;
            totalSkippedOutsideDay += parsed.skipped_outside_day;
            totalSkippedInvalidValueOrTimestamp +=
              parsed.skipped_invalid_value_or_timestamp;

            logStructured("info", "source_to_r2_openaq_location_processed", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: "openaq",
              location_id: locationId,
              archive_key: sourceFile.archive_key,
              source_found: true,
              mirror_reused: sourceFile.mirror_reused,
              mirror_written: sourceFile.mirror_written,
              csv_records: parsed.total_records,
              mapped_records: parsed.mapped_records,
              skipped_unknown_binding: parsed.skipped_unknown_binding,
              skipped_unknown_parameter: parsed.skipped_unknown_parameter,
              skipped_outside_day: parsed.skipped_outside_day,
              skipped_invalid_value_or_timestamp:
                parsed.skipped_invalid_value_or_timestamp,
            });
          }

          if (locationFilesFound === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: "no_location_day_source_files",
                candidate_location_count: candidateLocationIds.length,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          candidateSourceUnits = locationFilesFound;
          sourceCheckpointJson.candidate_location_count =
            candidateLocationIds.length;
          sourceCheckpointJson.location_files_found = locationFilesFound;
          sourceCheckpointJson.location_files_missing = locationFilesMissing;
          sourceCheckpointJson.location_files_mirror_reused =
            locationFilesMirrorReused;
          sourceCheckpointJson.location_files_mirror_written =
            locationFilesMirrorWritten;
          sourceCheckpointJson.total_csv_records = totalCsvRecords;
          sourceCheckpointJson.total_mapped_records = totalMappedRecords;
          sourceCheckpointJson.total_skipped_unknown_binding =
            totalSkippedUnknownBinding;
          sourceCheckpointJson.total_skipped_unknown_parameter =
            totalSkippedUnknownParameter;
          sourceCheckpointJson.total_skipped_outside_day =
            totalSkippedOutsideDay;
          sourceCheckpointJson.total_skipped_invalid_value_or_timestamp =
            totalSkippedInvalidValueOrTimestamp;
        } else if (sourceAdapter === "uk_air_sos") {
          const stationRefsLookup = await fetchStationRefsForConnector(
            connectorId,
          );
          const requestedStationRefs = getStationFilterForConnector(connectorId)
            ?.station_refs;
          const candidateStationRefs = requestedStationRefs?.size
            ? new Set(
              Array.from(stationRefsLookup.station_refs).filter((stationRef) =>
                requestedStationRefs.has(stationRef)
              ),
            )
            : stationRefsLookup.station_refs;
          if (candidateStationRefs.size === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: stationRefsLookup.station_refs.size === 0
                  ? "no_candidate_station_refs"
                  : "no_matching_station_refs",
                station_ref_count: stationRefsLookup.station_refs.size,
                requested_station_ref_count: requestedStationRefs?.size || null,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          const lookup = await fetchUkAirSosSourceLookupForConnector(
            connectorId,
            candidateStationRefs,
          );
          const candidateBindings = Array.from(
            lookup.binding_by_timeseries_ref.values(),
          )
            .filter((binding) => candidateStationRefs.has(binding.station_ref))
            .filter((binding) =>
              UK_AIR_SOS_INCLUDE_MET_FIELDS ||
              binding.pollutant_code === "no2" ||
              binding.pollutant_code === "pm25" ||
              binding.pollutant_code === "pm10"
            )
            .sort((left, right) => {
              const stationCompare = left.station_ref.localeCompare(
                right.station_ref,
              );
              if (stationCompare !== 0) {
                return stationCompare;
              }
              const refCompare = left.timeseries_ref.localeCompare(
                right.timeseries_ref,
              );
              if (refCompare !== 0) {
                return refCompare;
              }
              return left.timeseries_id - right.timeseries_id;
            });

          if (candidateBindings.length === 0) {
            connectorDaySkipped += 1;
            await ledgerInsertRunDay(ledgerEnabled, {
              run_id: runId,
              run_mode: RUN_MODE,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_kind: "download",
              status: "skipped",
              rows_read: 0,
              rows_written_aqilevels: 0,
              objects_written_r2: 0,
              checkpoint_json: {
                source_adapter: sourceAdapter,
                skip_reason: "no_matching_timeseries_bindings",
                candidate_station_ref_count: candidateStationRefs.size,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }

          const resolvedServiceUrl = await resolveConnectorServiceUrl(
            connectorId,
          );
          const sourceBaseUrl = (resolvedServiceUrl || UK_AIR_SOS_BASE_URL)
            .replace(/\/$/, "");
          const dayStartIso = utcDayStartIso(dayUtc);
          const dayEndIso = utcDayEndIso(dayUtc);
          const timespan = `${dayStartIso}/${dayEndIso}`;
          let knownNoDataTimeseriesEntries =
            new Map<string, UkAirSosNoDataManifestEntry>();
          try {
            knownNoDataTimeseriesEntries = readUkAirSosNoDataManifest(dayUtc);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logStructured(
              "warning",
              "source_to_r2_uk_air_sos_no_data_manifest_read_failed",
              {
                run_id: runId,
                day_utc: dayUtc,
                connector_id: connectorId,
                source_adapter: "uk_air_sos",
                error: message,
              },
            );
          }
          const knownNoDataTimeseriesRefs = new Set(
            knownNoDataTimeseriesEntries.keys(),
          );

          let timeseriesResults = await processUkAirSosTimeseriesBatch({
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            bindings: candidateBindings,
            concurrency: UK_AIR_SOS_FETCH_CONCURRENCY,
            base_url: sourceBaseUrl,
            timespan,
            known_empty_timeseries_refs: knownNoDataTimeseriesRefs,
            day_start_iso: dayStartIso,
            day_end_iso: dayEndIso,
          });
          let retryableFailedBindings = timeseriesResults
            .filter((result) =>
              result.error_message &&
              isRetryableSourceFetchError("uk_air_sos", result.error_message)
            )
            .map((result) => result.binding);
          for (
            let retryRound = 1;
            retryableFailedBindings.length > 0 &&
              retryRound <= UK_AIR_SOS_TIMESERIES_RETRY_ROUNDS;
            retryRound += 1
          ) {
            logStructured("info", "source_to_r2_uk_air_sos_retry_round", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: "uk_air_sos",
              retry_round: retryRound,
              retry_candidate_count: retryableFailedBindings.length,
              retry_concurrency: UK_AIR_SOS_TIMESERIES_RETRY_CONCURRENCY,
            });
            await sleep(
              Math.min(
                60000,
                UK_AIR_SOS_TIMESERIES_RETRY_BASE_MS * retryRound,
              ),
            );
            const retriedResults = await processUkAirSosTimeseriesBatch({
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              bindings: retryableFailedBindings,
              concurrency: UK_AIR_SOS_TIMESERIES_RETRY_CONCURRENCY,
              base_url: sourceBaseUrl,
              timespan,
              known_empty_timeseries_refs: knownNoDataTimeseriesRefs,
              day_start_iso: dayStartIso,
              day_end_iso: dayEndIso,
              retry_round: retryRound,
            });
            const retriedByTimeseriesRef = new Map(
              retriedResults.map((result) => [
                result.binding.timeseries_ref,
                result,
              ]),
            );
            timeseriesResults = timeseriesResults.map((result) =>
              retriedByTimeseriesRef.get(result.binding.timeseries_ref) || result
            );
            retryableFailedBindings = timeseriesResults
              .filter((result) =>
                result.error_message &&
                isRetryableSourceFetchError("uk_air_sos", result.error_message)
              )
              .map((result) => result.binding);
          }

          let totalRawPoints = 0;
          let totalMappedPoints = 0;
          let totalMirrorReused = 0;
          let totalMirrorWritten = 0;
          let totalNoDataManifestReused = 0;
          let totalSkippedOutsideDay = 0;
          let totalSkippedNullValue = 0;
          const failedTimeseries: string[] = [];
          for (const result of timeseriesResults) {
            observationRowsRaw.push(...result.rows);
            totalRawPoints += result.raw_point_count;
            totalMappedPoints += result.mapped_point_count;
            totalMirrorReused += result.mirror_reused ? 1 : 0;
            totalMirrorWritten += result.mirror_written ? 1 : 0;
            totalNoDataManifestReused += result.no_data_manifest_reused ? 1 : 0;
            totalSkippedOutsideDay += result.skipped_outside_day;
            totalSkippedNullValue += result.skipped_null_value;
            if (
              result.empty_payload_confirmed &&
              result.timeseries_ref &&
              !knownNoDataTimeseriesEntries.has(result.timeseries_ref)
            ) {
              knownNoDataTimeseriesEntries.set(result.timeseries_ref, {
                timeseries_ref: result.timeseries_ref,
                station_ref: result.station_ref || null,
                recorded_at_utc: nowIso(),
              });
            }
            if (result.error_message) {
              failedTimeseries.push(result.error_message);
            }
          }

          const noDataManifestWrittenCount =
            knownNoDataTimeseriesEntries.size - knownNoDataTimeseriesRefs.size;
          if (noDataManifestWrittenCount > 0) {
            try {
              writeUkAirSosNoDataManifest({
                day_utc: dayUtc,
                entries: knownNoDataTimeseriesEntries,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logStructured(
                "warning",
                "source_to_r2_uk_air_sos_no_data_manifest_write_failed",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: "uk_air_sos",
                  error: message,
                },
              );
            }
          }

          if (failedTimeseries.length > 0) {
            throw new Error(
              `uk_air_sos_timeseries_fetch_failed: ${failedTimeseries.length} timeseries failed: ${
                failedTimeseries.slice(0, 5).join(" | ")
              }`,
            );
          }

          candidateSourceUnits = candidateBindings.length;
          sourceCheckpointJson.source_base_url = sourceBaseUrl;
          sourceCheckpointJson.timespan = timespan;
          sourceCheckpointJson.candidate_station_ref_count =
            candidateStationRefs.size;
          sourceCheckpointJson.candidate_timeseries_count =
            candidateBindings.length;
          sourceCheckpointJson.mirror_reused_count = totalMirrorReused;
          sourceCheckpointJson.mirror_written_count = totalMirrorWritten;
          sourceCheckpointJson.no_data_manifest_reused_count =
            totalNoDataManifestReused;
          sourceCheckpointJson.no_data_manifest_written_count =
            noDataManifestWrittenCount;
          sourceCheckpointJson.total_raw_points = totalRawPoints;
          sourceCheckpointJson.total_mapped_points = totalMappedPoints;
          sourceCheckpointJson.total_skipped_outside_day =
            totalSkippedOutsideDay;
          sourceCheckpointJson.total_skipped_null_value = totalSkippedNullValue;
        } else {
          throw new Error(
            `unsupported source_to_r2 adapter=${sourceAdapter} for connector_id=${connectorId}`,
          );
        }

        const dedupedObservationRows = dedupeSourceObservationRows(
          observationRowsRaw,
        );
        rowsRead += dedupedObservationRows.length;

        const obsHistoryRows = sourceObservationsToObsHistoryRows(
          dedupedObservationRows,
        );
        const helperRows = sourceObservationRowsToHelperRowsForDay(
          dedupedObservationRows,
          dayUtc,
        );
        const aqilevelRows = helperRowsToAqilevelHistoryRows(helperRows);
        rowsWrittenAqilevels += aqilevelRows.length;

        if (obsHistoryRows.length === 0 || aqilevelRows.length === 0) {
          connectorDaySkipped += 1;
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "download",
            status: "skipped",
            rows_read: obsHistoryRows.length,
            rows_written_aqilevels: aqilevelRows.length,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              skip_reason: "no_observations_or_aqilevel_rows",
              candidate_source_units: candidateSourceUnits,
              rows_observations: obsHistoryRows.length,
              rows_aqilevels: aqilevelRows.length,
              ...sourceCheckpointJson,
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          continue;
        }

        if (DRY_RUN) {
          connectorDaySkipped += 1;
          logStructured("info", "source_to_r2_connector_day_dry_run_plan", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: sourceAdapter,
            candidate_source_units: candidateSourceUnits,
            rows_observations: obsHistoryRows.length,
            rows_aqilevels: aqilevelRows.length,
          });
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "download",
            status: "dry_run",
            rows_read: obsHistoryRows.length,
            rows_written_aqilevels: aqilevelRows.length,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              candidate_source_units: candidateSourceUnits,
              rows_observations: obsHistoryRows.length,
              rows_aqilevels: aqilevelRows.length,
              ...sourceCheckpointJson,
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          sourceProcessedDaySet.add(dayUtc);
          continue;
        }

        const obsExport = await exportObsConnectorRowsToR2({
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          rows: obsHistoryRows,
        });
        const aqiExport = await exportAqiConnectorRowsToR2({
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          rows: aqilevelRows,
        });
        objectsWrittenR2 += obsExport.objects_written_r2 +
          aqiExport.objects_written_r2;

        const obsConnectorManifests = await loadAllObsConnectorManifestsForDay(
          dayUtc,
        );
        const aqiConnectorManifests = await loadAllAqiConnectorManifestsForDay(
          dayUtc,
        );
        if (!obsConnectorManifests.length || !aqiConnectorManifests.length) {
          throw new Error(
            `missing connector manifests for day=${dayUtc} after source_to_r2 export`,
          );
        }
        const obsDayManifest = createObsDayManifest({
          dayUtc,
          runId,
          connectorManifests: obsConnectorManifests,
          writerGitSha: OBS_R2_WRITER_GIT_SHA,
          backedUpAtUtc: nowIso(),
        });
        const aqiDayManifest = createAqiDayManifest({
          dayUtc,
          runId,
          connectorManifests: aqiConnectorManifests,
          writerGitSha: OBS_R2_WRITER_GIT_SHA,
          backedUpAtUtc: nowIso(),
        });
        await r2PutObject({
          r2: OBS_R2_CONFIG,
          key: buildObsDayManifestKey(dayUtc),
          body: encodeJsonBody(obsDayManifest),
          content_type: "application/json",
        });
        await r2PutObject({
          r2: OBS_R2_CONFIG,
          key: buildAqiDayManifestKey(dayUtc),
          body: encodeJsonBody(aqiDayManifest),
          content_type: "application/json",
        });
        objectsWrittenR2 += 2;
        connectorDayComplete += 1;
        sourceProcessedDaySet.add(dayUtc);
        logStructured("info", "source_to_r2_connector_day_complete", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_adapter: sourceAdapter,
          candidate_source_units: candidateSourceUnits,
          rows_observations: obsHistoryRows.length,
          rows_aqilevels: aqilevelRows.length,
          objects_written_r2: obsExport.objects_written_r2 +
            aqiExport.objects_written_r2 + 2,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "download",
          status: "complete",
          rows_read: obsHistoryRows.length,
          rows_written_aqilevels: aqilevelRows.length,
          objects_written_r2: obsExport.objects_written_r2 +
            aqiExport.objects_written_r2 + 2,
          checkpoint_json: {
            source_adapter: sourceAdapter,
            observation_manifest_key: obsExport.manifest_key,
            aqilevels_manifest_key: aqiExport.manifest_key,
            day_observation_manifest_key: buildObsDayManifestKey(dayUtc),
            day_aqilevels_manifest_key: buildAqiDayManifestKey(dayUtc),
            candidate_source_units: candidateSourceUnits,
            ...sourceCheckpointJson,
          },
          started_at: startedAt,
          finished_at: nowIso(),
        });
        await ledgerUpsertCheckpoint(ledgerEnabled, {
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "download",
          status: "complete",
          rows_read: obsHistoryRows.length,
          rows_written_aqilevels: aqilevelRows.length,
          objects_written_r2: obsExport.objects_written_r2 +
            aqiExport.objects_written_r2 + 2,
          checkpoint_json: {
            source_adapter: sourceAdapter,
            observation_manifest_key: obsExport.manifest_key,
            aqilevels_manifest_key: aqiExport.manifest_key,
            updated_by_run_id: runId,
            completed_at: nowIso(),
            candidate_source_units: candidateSourceUnits,
            ...sourceCheckpointJson,
          },
          updated_at: nowIso(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSourceAcquisitionPendingError(sourceAdapter, message)) {
          sourceAcquisitionPendingDaySet.add(dayUtc);
          warnings.push(
            `Pending ${sourceAdapter} source acquisition for ${dayUtc}: ${message}`,
          );
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "download",
            status: "stubbed",
            rows_read: 0,
            rows_written_aqilevels: 0,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              pending_reason: "source_acquisition",
            },
            error_json: { message },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          await ledgerUpsertCheckpoint(ledgerEnabled, {
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "download",
            status: "stubbed",
            rows_read: 0,
            rows_written_aqilevels: 0,
            objects_written_r2: 0,
            checkpoint_json: {
              updated_by_run_id: runId,
              source_adapter: sourceAdapter,
              pending_reason: "source_acquisition",
              pending_at: nowIso(),
            },
            error_json: { message },
            updated_at: nowIso(),
          });
          logStructured("warning", "source_to_r2_connector_day_pending", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: sourceAdapter,
            pending_reason: "source_acquisition",
            error: message,
          });
          continue;
        }
        connectorDayError += 1;
        sourceFailedDaySet.add(dayUtc);
        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "download",
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
          source_kind: "download",
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
          source_kind: "download",
          error_json: { message },
          started_at: startedAt,
          finished_at: nowIso(),
        });
        logStructured("error", "source_to_r2_connector_day_failed", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_adapter: sourceAdapter,
          error: message,
        });
      }
    }
  }

  const allTouchedDaySet = new Set<string>([
    ...sourceProcessedDaySet,
    ...sourceFailedDaySet,
    ...sourceAcquisitionPendingDaySet,
  ]);

  return {
    mode: "source_to_r2",
    run_id: runId,
    dry_run: DRY_RUN,
    from_day_utc: window.from_day_utc,
    to_day_utc: window.to_day_utc,
    days_planned: requestedDays.length,
    days_processed: allTouchedDaySet.size,
    source_connector_day_complete: connectorDayComplete,
    source_connector_day_skipped: connectorDaySkipped,
    source_connector_day_error: connectorDayError,
    source_processed_days: Array.from(sourceProcessedDaySet).sort(
      compareIsoDay,
    ),
    source_failed_days: Array.from(sourceFailedDaySet).sort(compareIsoDay),
    rows_read: rowsRead,
    rows_written_aqilevels: rowsWrittenAqilevels,
    objects_written_r2: objectsWrittenR2,
    retention_window: retentionWindow,
    local_to_aqilevels_days: [],
    source_acquisition_pending_days: Array.from(sourceAcquisitionPendingDaySet)
      .sort(compareIsoDay),
    local_to_aqilevels_summary: null,
    warnings,
  };
}

async function main(): Promise<void> {
  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  resetRunCaches();
  const window = resolveRunWindow();
  await resolveRequestedStationFilters();
  const ledgerEnabled = RUN_MODE === "r2_history_obs_to_aqilevels"
    ? false
    : await detectLedgerEnabled();

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
    connector_ids: effectiveConnectorIds,
    connector_ids_requested: CONNECTOR_IDS,
    station_ids_requested: REQUESTED_STATION_IDS,
    unresolved_station_ids: unresolvedRequestedStationIds,
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
        errorMessage =
          `local_to_aqilevels encountered ${summary.connector_day_error} connector-day errors`;
      }
    } else if (RUN_MODE === "obs_aqi_to_r2") {
      summary = await runObservsToR2(runId, window, ledgerEnabled);
      if (
        summary.connector_day_error > 0 ||
        (!DRY_RUN && summary.pending_backfill_days.length > 0)
      ) {
        runStatus = "error";
        errorMessage =
          `obs_aqi_to_r2 encountered ${summary.connector_day_error} connector-day errors and has ${summary.pending_backfill_days.length} pending day(s)`;
      } else {
        runStatus = DRY_RUN ? "dry_run" : "ok";
      }
    } else if (RUN_MODE === "r2_history_obs_to_aqilevels") {
      summary = await runR2HistoryObsToAqilevels(runId, window, ledgerEnabled);
      if (summary.connector_day_error > 0 || summary.failed_days.length > 0) {
        runStatus = "error";
        errorMessage =
          `r2_history_obs_to_aqilevels encountered ${summary.connector_day_error} connector-day errors and ${summary.failed_days.length} failed day(s)`;
      } else {
        runStatus = DRY_RUN ? "dry_run" : "ok";
      }
    } else {
      summary = await runSourceToAll(runId, window, ledgerEnabled);
      if (summary.source_connector_day_error > 0) {
        runStatus = "error";
        errorMessage =
          `source_to_r2 encountered ${summary.source_connector_day_error} connector-day errors`;
      } else if (
        !DRY_RUN && summary.source_acquisition_pending_days.length > 0
      ) {
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
    rows_written_aqilevels: "rows_written_aqilevels" in summary
      ? summary.rows_written_aqilevels
      : 0,
    objects_written_r2: "objects_written_r2" in summary
      ? summary.objects_written_r2
      : 0,
    checkpoint_json: {
      summary,
      connector_ids: effectiveConnectorIds,
      connector_ids_requested: CONNECTOR_IDS,
      station_ids_requested: REQUESTED_STATION_IDS,
      unresolved_station_ids: unresolvedRequestedStationIds,
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
    connector_ids: effectiveConnectorIds,
    connector_ids_requested: CONNECTOR_IDS,
    station_ids_requested: REQUESTED_STATION_IDS,
    unresolved_station_ids: unresolvedRequestedStationIds,
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
