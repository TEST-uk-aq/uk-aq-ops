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
  parseBackfillOutputScope,
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
import {
  reconcileIntegritySourceAdapterBlockedRows,
} from "./source_integrity/blocked_rows.ts";
type RunMode =
  | "local_to_aqilevels"
  | "obs_aqi_to_r2"
  | "source_to_r2"
  | "r2_history_obs_to_aqilevels";
type BackfillOutputScope = "default" | "observations_only" | "aqilevels_only";
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

type SourcePollutantCode = string;

export type ObservedPropertyMapping = {
  connector_id: number;
  source_label: string;
  source_uom: string | null;
  observed_property_id: number | null;
  observed_property_code: string | null;
  mapping_kind: "raw_observed_property" | "meteorological" | "ignored" | "unknown";
  is_aqi_eligible: boolean;
  is_active: boolean;
};

type SourceTimeseriesBinding = {
  timeseries_id: number;
  station_id: number;
  station_ref: string;
  timeseries_ref: string;
  pollutant_code: SourcePollutantCode;
};

type SosSiteTimeseriesRef = {
  site_ref: string;
  uk_air_ref: string | null;
  pollutant_code: SourcePollutantCode;
  station_id: number;
  timeseries_id: number;
  station_ref: string | null;
  timeseries_ref: string | null;
  valid_from_day_utc: string | null;
  valid_to_day_utc: string | null;
};

type SourceConnectorLookup = {
  connector_id: number;
  station_refs: Set<string>;
  binding_by_station_pollutant: Map<string, SourceTimeseriesBinding>;
  binding_by_timeseries_id: Map<number, SourceTimeseriesBinding>;
  binding_by_timeseries_ref: Map<string, SourceTimeseriesBinding>;
  binding_by_timeseries_ref_pollutant: Map<string, SourceTimeseriesBinding>;
  ambiguous_station_pollutant_keys: Set<string>;
  ambiguous_timeseries_ref_keys: Set<string>;
  ambiguous_timeseries_ref_pollutant_keys: Set<string>;
};

type SourceAdapterKind =
  | "breathelondon"
  | "sensorcommunity"
  | "openaq"
  | "sos";

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
  status?: string | null;
  source_parameter?: string | null;
};

const INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT = 10;

type SosDatapoint = {
  observed_at: string;
  value: number | null;
  status: string | null;
};

type SosTimeseriesProcessResult = {
  binding: SourceTimeseriesBinding;
  station_ref: string;
  timeseries_ref: string;
  rows: SourceObservationRow[];
  raw_point_count: number;
  mapped_point_count: number;
  mirror_reused: boolean;
  mirror_written: boolean;
  integrity_snapshot_reused: boolean;
  no_data_manifest_reused: boolean;
  empty_payload_confirmed: boolean;
  skipped_outside_day: number;
  skipped_null_value: number;
  error_message: string | null;
};

type SosNoDataManifestEntry = {
  timeseries_ref: string;
  station_ref: string | null;
  recorded_at_utc: string;
};

type SosTimeseriesFetchResult = {
  payload: unknown;
  mirror_reused: boolean;
  mirror_written: boolean;
  integrity_snapshot_reused: boolean;
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
  station_id?: number | null;
  pollutant_code?: SourcePollutantCode | null;
  observed_at: string;
  value: number | null;
  status?: string | null;
};

type ObsHistoryParquetRow = {
  connector_id: number;
  timeseries_id: number;
  observed_at: string;
  value: number | null;
  status: string | null;
};

type ObsHistoryV2ParquetRow = ObsHistoryParquetRow & {
  station_id: number | null;
  pollutant_code: string;
};

type AqilevelsHistoryRow = {
  timeseries_id: number;
  station_id: number | null;
  connector_id: number;
  pollutant_code: "no2" | "pm25" | "pm10";
  timestamp_hour_utc: string;
  daqi_input_value_ugm3: number | null;
  daqi_input_averaging_code: string | null;
  daqi_source_observation_count: number | null;
  daqi_required_observation_count: number | null;
  daqi_calculation_status: string | null;
  daqi_missing_reason: string | null;
  eaqi_input_value_ugm3: number | null;
  eaqi_input_averaging_code: string | null;
  eaqi_source_observation_count: number | null;
  eaqi_required_observation_count: number | null;
  eaqi_calculation_status: string | null;
  eaqi_missing_reason: string | null;
  hourly_mean_ugm3: number | null;
  rolling24h_mean_ugm3: number | null;
  hourly_sample_count: number | null;
  daqi_index_level: number | null;
  eaqi_index_level: number | null;
  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;
  daqi_no2_index_level: number | null;
  daqi_pm25_rolling24h_index_level: number | null;
  daqi_pm10_rolling24h_index_level: number | null;
  eaqi_no2_index_level: number | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm10_index_level: number | null;
  algorithm_version: string | null;
  computed_at_utc: string | null;
  updated_at: string | null;
};

type AqilevelsHistoryParquetRow = {
  connector_id: number;
  timeseries_id: number;
  station_id: number | null;
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
  algorithm_version: string | null;
  computed_at_utc: string | null;
  hourly_mean_ugm3: number | null;
  rolling24h_mean_ugm3: number | null;
  no2_hourly_mean_ugm3: number | null;
  pm25_hourly_mean_ugm3: number | null;
  pm10_hourly_mean_ugm3: number | null;
  pm25_rolling24h_mean_ugm3: number | null;
  pm10_rolling24h_mean_ugm3: number | null;
  daqi_no2_index_level: number | null;
  daqi_pm25_rolling24h_index_level: number | null;
  daqi_pm10_rolling24h_index_level: number | null;
  eaqi_no2_index_level: number | null;
  eaqi_pm25_index_level: number | null;
  eaqi_pm10_index_level: number | null;
  updated_at: string | null;
};

type ObsHistoryFileEntry = {
  key: string;
  row_count: number;
  bytes: number;
  etag_or_hash: string | null;
  pollutant_codes?: string[] | null;
  min_timeseries_id?: number | null;
  max_timeseries_id?: number | null;
  min_observed_at?: string | null;
  max_observed_at?: string | null;
  min_timestamp_hour_utc?: string | null;
  max_timestamp_hour_utc?: string | null;
  // Internal-only: per-part counts used to compute the connector-level
  // top-level `timeseries_row_counts` aggregate. Stripped from the
  // serialized manifest by stripTimeseriesCountsFromFileEntries.
  timeseries_row_counts?: Record<string, number> | null;
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
  diagnostic_reason?: string | null;
  diagnostic_counters?: Record<string, number>;
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

function buildAqiGenerationDiagnostics(
  rows: SourceObservationRow[],
  dayUtc: string,
  rowsWrittenAqilevels: number,
): { counters: Record<string, number>; reason: string | null } {
  const supportedRows = rows.filter((row) =>
    row.pollutant_code === "no2" ||
    row.pollutant_code === "pm25" ||
    row.pollutant_code === "pm10"
  );
  const validValueRows = supportedRows.filter((row) =>
    typeof row.value === "number" && Number.isFinite(row.value) && row.value >= 0
  );
  const narrowRows = sourceObservationsToNarrowRowsCore(validValueRows);
  const helperRows = sourceObservationRowsToHelperRowsForDayCore(validValueRows, dayUtc);
  const thresholdMatchedRows = helperRowsToAqilevelHistoryRowsCore(helperRows)
    .filter((row) =>
      row !== null &&
      (row.daqi_index_level !== null || row.eaqi_index_level !== null)
    );
  const counters = {
    rows_read: rows.length,
    rows_after_pollutant_mapping: supportedRows.length,
    rows_after_valid_value_filter: validValueRows.length,
    rows_after_hourly_grouping: narrowRows.length,
    rows_after_day_filter: helperRows.length,
    rows_after_threshold_join: thresholdMatchedRows.length,
    rows_written_aqilevels: rowsWrittenAqilevels,
  };
  let reason: string | null = null;
  if (rows.length > 0 && supportedRows.length === 0) {
    reason = "no_supported_aqi_pollutants_after_pollutant_mapping";
  } else if (supportedRows.length > 0 && validValueRows.length === 0) {
    reason = "no_valid_non_negative_numeric_values";
  } else if (validValueRows.length > 0 && narrowRows.length === 0) {
    reason = "no_rows_after_hourly_grouping";
  } else if (narrowRows.length > 0 && helperRows.length === 0) {
    reason = "no_rows_in_requested_day_after_day_filter";
  } else if (helperRows.length > 0 && rowsWrittenAqilevels === 0) {
    reason = thresholdMatchedRows.length === 0
      ? "no_rows_matched_aqi_thresholds"
      : "aqi_rows_filtered_before_write";
  }
  return { counters, reason };
}

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
  "status",
]);
const HISTORY_OBSERVATIONS_COLUMNS_R2_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "observed_at_utc",
  "value",
  "status",
]);
const HISTORY_AQILEVELS_SCHEMA_NAME = "aqilevels_hourly";
const HISTORY_AQILEVELS_SCHEMA_VERSION = 1;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v1";
const HISTORY_AQILEVELS_COLUMNS = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_input_value_ugm3",
  "daqi_input_averaging_code",
  "daqi_index_level",
  "daqi_source_observation_count",
  "daqi_required_observation_count",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_input_value_ugm3",
  "eaqi_input_averaging_code",
  "eaqi_index_level",
  "eaqi_source_observation_count",
  "eaqi_required_observation_count",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
  "hourly_sample_count",
  "algorithm_version",
  "computed_at_utc",
  "hourly_mean_ugm3",
  "rolling24h_mean_ugm3",
  "no2_hourly_mean_ugm3",
  "pm25_hourly_mean_ugm3",
  "pm10_hourly_mean_ugm3",
  "pm25_rolling24h_mean_ugm3",
  "pm10_rolling24h_mean_ugm3",
  "daqi_no2_index_level",
  "daqi_pm25_rolling24h_index_level",
  "daqi_pm10_rolling24h_index_level",
  "eaqi_no2_index_level",
  "eaqi_pm25_index_level",
  "eaqi_pm10_index_level",
  "updated_at",
]);
const HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_index_level",
  "eaqi_index_level",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
]);
const HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2 = Object.freeze([
  "connector_id",
  "station_id",
  "timeseries_id",
  "pollutant_code",
  "timestamp_hour_utc",
  "daqi_input_value_ugm3",
  "daqi_input_averaging_code",
  "daqi_index_level",
  "daqi_source_observation_count",
  "daqi_required_observation_count",
  "daqi_calculation_status",
  "daqi_missing_reason",
  "eaqi_input_value_ugm3",
  "eaqi_input_averaging_code",
  "eaqi_index_level",
  "eaqi_source_observation_count",
  "eaqi_required_observation_count",
  "eaqi_calculation_status",
  "eaqi_missing_reason",
  "hourly_sample_count",
  "algorithm_version",
  "computed_at_utc",
]);
const HISTORY_R2_V2_OBSERVATIONS_PREFIX = "history/v2/observations";
const HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX = "history/v2/aqilevels/hourly/data";
const HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX = "history/v2/aqilevels/hourly/debug";
const HISTORY_R2_V2_SCHEMA_VERSION = 2;
const HISTORY_R2_V2_WRITER_VERSION = "parquet-wasm-zstd-v2";

const CANONICAL_R2_HISTORY_VERSION_ENV = "UK_AQ_R2_HISTORY_VERSION";
const DEPRECATED_R2_HISTORY_VERSION_ENVS = [
  "UK_AQ_R2_HISTORY_READ_VERSION",
  "UK_AQ_R2_HISTORY_WRITE_VERSION",
  "UK_AQ_R2_HISTORY_BACKUP_VERSION",
];

function resolveHistoryWriteVersionFromEnv(): "v1" | "v2" {
  const presentDeprecated = DEPRECATED_R2_HISTORY_VERSION_ENVS.filter((name) => Deno.env.get(name) !== undefined);
  if (presentDeprecated.length > 0) {
    throw new Error(
      `R2 local backfill no longer supports ${presentDeprecated.join(", ")}. `
        + `Use ${CANONICAL_R2_HISTORY_VERSION_ENV}=v1|v2 and delete the old split read/write/backup vars.`,
    );
  }
  const raw = Deno.env.get(CANONICAL_R2_HISTORY_VERSION_ENV);
  const value = String(raw || "").trim().toLowerCase();
  if (value === "v1" || value === "v2") {
    return value;
  }
  if (!value) {
    throw new Error(`Missing ${CANONICAL_R2_HISTORY_VERSION_ENV}; set ${CANONICAL_R2_HISTORY_VERSION_ENV}=v1 or ${CANONICAL_R2_HISTORY_VERSION_ENV}=v2.`);
  }
  throw new Error(`Invalid ${CANONICAL_R2_HISTORY_VERSION_ENV}=${JSON.stringify(String(raw))}; expected v1 or v2`);
}

const OBS_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX") ||
    "history/v1/observations",
) || "history/v1/observations";
const AQI_R2_HISTORY_PREFIX = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_AQILEVELS_PREFIX") || "history/v1/aqilevels/hourly",
) || "history/v1/aqilevels/hourly";
const HISTORY_R2_WRITE_VERSION = resolveHistoryWriteVersionFromEnv();
const OBS_R2_HISTORY_PREFIX_V2 = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX") ||
    HISTORY_R2_V2_OBSERVATIONS_PREFIX,
) || HISTORY_R2_V2_OBSERVATIONS_PREFIX;
const AQI_R2_HISTORY_DATA_PREFIX_V2 = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX") ||
    HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX,
) || HISTORY_R2_V2_AQILEVELS_HOURLY_DATA_PREFIX;
const AQI_R2_HISTORY_DEBUG_PREFIX_V2 = normalizePrefix(
  Deno.env.get("UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX") ||
    HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX,
) || HISTORY_R2_V2_AQILEVELS_HOURLY_DEBUG_PREFIX;
const CORE_R2_HISTORY_PREFIX = HISTORY_R2_WRITE_VERSION === "v2"
  ? (normalizePrefix(
    Deno.env.get("UK_AQ_R2_HISTORY_V2_CORE_PREFIX") || "history/v2/core",
  ) || "history/v2/core")
  : (normalizePrefix(
    Deno.env.get("UK_AQ_R2_HISTORY_CORE_PREFIX") || "history/v1/core",
  ) || "history/v1/core");
const R2_HISTORY_DROPBOX_ROOT = optionalEnvAny([
  "UK_AQ_R2_HISTORY_DROPBOX_ROOT",
  "UK_AQ_BACKFILL_R2_HISTORY_DROPBOX_ROOT",
]);
const OBS_R2_WRITER_GIT_SHA = (Deno.env.get("GITHUB_SHA") || "").trim() || null;
const OBS_R2_CONFIG = {
  endpoint:
    (Deno.env.get("CFLARE_R2_ENDPOINT") || Deno.env.get("R2_ENDPOINT") || "")
      .trim(),
  bucket: resolveR2Bucket(),
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
const BACKFILL_OUTPUT_SCOPE_RAW = (
  Deno.env.get("UK_AQ_BACKFILL_OUTPUT_SCOPE") || ""
).trim().toLowerCase();
const BACKFILL_OUTPUT_SCOPE = parseBackfillOutputScope(
  BACKFILL_OUTPUT_SCOPE_RAW,
  "default",
) as BackfillOutputScope;
const FORCE_REPLACE = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_FORCE_REPLACE"),
  false,
);
const ENABLE_R2_FALLBACK = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_ENABLE_R2_FALLBACK"),
  false,
);
const SHOULD_USE_R2_CORE_METADATA = true;
const INTEGRITY_CHUNK_MERGE = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_CHUNK_MERGE"),
  true,
);
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
const R2_HISTORY_PART_MAX_ROWS = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_PART_MAX_ROWS"),
  1000000,
  1000,
  5000000,
);
const R2_HISTORY_ROW_GROUP_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_ROW_GROUP_SIZE"),
  100000,
  10000,
  2000000,
);
const OBS_R2_PART_MAX_ROWS = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS") ||
    Deno.env.get("UK_AQ_R2_HISTORY_PART_MAX_ROWS"),
  500000,
  1000,
  5000000,
);
const OBS_R2_ROW_GROUP_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE") ||
    Deno.env.get("UK_AQ_R2_HISTORY_ROW_GROUP_SIZE"),
  50000,
  10000,
  2000000,
);
const AQI_R2_PART_MAX_ROWS = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS") ||
    Deno.env.get("UK_AQ_R2_HISTORY_PART_MAX_ROWS"),
  R2_HISTORY_PART_MAX_ROWS,
  1000,
  5000000,
);
const AQI_R2_ROW_GROUP_SIZE = parsePositiveInt(
  Deno.env.get("UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE") ||
    Deno.env.get("UK_AQ_R2_HISTORY_ROW_GROUP_SIZE"),
  R2_HISTORY_ROW_GROUP_SIZE,
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
const SOS_SOURCE_ENABLED = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_SOS_SOURCE_ENABLED"),
  true,
);
const SOS_CONNECTOR_CODE = (
  Deno.env.get("UK_AQ_BACKFILL_SOS_CONNECTOR_CODE") || "sos"
).trim().toLowerCase();
const SOS_CONNECTOR_ID_FALLBACK = Number.parseInt(
  Deno.env.get("UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK") || "1",
  10,
);
const SOS_BASE_URL = "https://uk-air.defra.gov.uk/sos-ukair/api/v1";
const SOS_FLAT_FILE_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_SOS_FLAT_FILE_ROOT",
);
const SOS_TIMEOUT_MS = 60000;
const SOS_FETCH_RETRIES = 3;
const SOS_RETRY_BASE_MS = 1500;
const SOS_FETCH_CONCURRENCY = 5;
const SOS_TIMESERIES_RETRY_ROUNDS = 2;
const SOS_TIMESERIES_RETRY_BASE_MS = 5000;
const SOS_TIMESERIES_RETRY_CONCURRENCY = 2;
const SOS_RAW_MIRROR_ROOT: string | null = null;
const SOS_INTEGRITY_SNAPSHOT_ROOT: string | null = null;
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
const INTEGRITY_PROPOSAL_MODE = optionalEnv(
  "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE",
) === "prepare";
const INTEGRITY_PROPOSAL_ROOT = optionalEnv(
  "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_ROOT",
);
const INTEGRITY_PROPOSAL_FINALIZE = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE"),
  false,
);
const INTEGRITY_PROPOSAL_CLEANUP = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_CLEANUP"),
  true,
);
const INTEGRITY_COMPLETE_CONNECTOR_DAY = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_COMPLETE_CONNECTOR_DAY"),
  false,
);
const INTEGRITY_SOURCE_EVIDENCE_ONLY = parseBooleanish(
  Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY"),
  false,
);
const INTEGRITY_OBSERVATION_REPAIR_POLLUTANTS = new Set(["pm25", "pm10", "no2", "o3"]);
const INTEGRITY_REPAIR_POLLUTANTS = new Set(
  (Deno.env.get("UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0),
);
for (const pollutant of INTEGRITY_REPAIR_POLLUTANTS) {
  if (!INTEGRITY_OBSERVATION_REPAIR_POLLUTANTS.has(pollutant)) {
    throw new Error(`unsupported_integrity_repair_pollutant pollutant_code=${pollutant}`);
  }
}
const INTEGRITY_POLLUTANT_SCOPED_REPAIR =
  INTEGRITY_COMPLETE_CONNECTOR_DAY && INTEGRITY_REPAIR_POLLUTANTS.size > 0;
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
    output_scope: BACKFILL_OUTPUT_SCOPE,
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

function validateRunModeOutputScope(): void {
  if (
    BACKFILL_OUTPUT_SCOPE_RAW &&
    BACKFILL_OUTPUT_SCOPE_RAW !== "default" &&
    BACKFILL_OUTPUT_SCOPE_RAW !== "observations_only" &&
    BACKFILL_OUTPUT_SCOPE_RAW !== "aqilevels_only"
  ) {
    throw new Error(
      `Invalid UK_AQ_BACKFILL_OUTPUT_SCOPE value: ${BACKFILL_OUTPUT_SCOPE_RAW}. Allowed: default, observations_only, aqilevels_only.`,
    );
  }
  if (BACKFILL_OUTPUT_SCOPE === "default") {
    return;
  }
  if (
    BACKFILL_OUTPUT_SCOPE === "observations_only" &&
    RUN_MODE !== "source_to_r2"
  ) {
    throw new Error(
      `Invalid output scope combination: UK_AQ_BACKFILL_OUTPUT_SCOPE=${BACKFILL_OUTPUT_SCOPE} requires UK_AQ_BACKFILL_RUN_MODE=source_to_r2.`,
    );
  }
  if (
    BACKFILL_OUTPUT_SCOPE === "aqilevels_only" &&
    RUN_MODE !== "r2_history_obs_to_aqilevels"
  ) {
    throw new Error(
      `Invalid output scope combination: UK_AQ_BACKFILL_OUTPUT_SCOPE=${BACKFILL_OUTPUT_SCOPE} requires UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels.`,
    );
  }
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

function resolveR2Bucket(): string {
  const explicit = optionalEnvAny(["CFLARE_R2_BUCKET", "R2_BUCKET"]);
  if (explicit) {
    return explicit;
  }
  return "";
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
let r2CoreObservedPropertyMappingsPromise:
  | Promise<ObservedPropertyMapping[]>
  | null = null;
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
  r2CoreObservedPropertyMappingsPromise = null;
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
  return `${activeObsHistoryPrefix()}/day_utc=${dayUtc}/manifest.json`;
}

function buildAqiDayManifestKey(dayUtc: string): string {
  return `${activeAqiHistoryDataPrefix()}/day_utc=${dayUtc}/manifest.json`;
}

function buildAqiDebugDayManifestKey(dayUtc: string): string {
  return `${activeAqiHistoryDebugPrefix()}/day_utc=${dayUtc}/manifest.json`;
}

function buildCoreDayManifestKey(dayUtc: string): string {
  return `${CORE_R2_HISTORY_PREFIX}/day_utc=${dayUtc}/manifest.json`;
}

function buildObsDayPrefix(dayUtc: string): string {
  return `${activeObsHistoryPrefix()}/day_utc=${dayUtc}`;
}

function buildAqiDayPrefix(dayUtc: string): string {
  return `${activeAqiHistoryDataPrefix()}/day_utc=${dayUtc}`;
}

function buildObsConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${activeObsHistoryPrefix()}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildAqiConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${activeAqiHistoryDataPrefix()}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildAqiDebugConnectorPrefix(dayUtc: string, connectorId: number): string {
  return `${activeAqiHistoryDebugPrefix()}/day_utc=${dayUtc}/connector_id=${connectorId}`;
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

function activeObsHistoryPrefix(): string {
  return HISTORY_R2_WRITE_VERSION === "v2"
    ? OBS_R2_HISTORY_PREFIX_V2
    : OBS_R2_HISTORY_PREFIX;
}

function activeAqiHistoryDataPrefix(): string {
  return HISTORY_R2_WRITE_VERSION === "v2"
    ? AQI_R2_HISTORY_DATA_PREFIX_V2
    : AQI_R2_HISTORY_PREFIX;
}

function activeAqiHistoryDebugPrefix(): string {
  return HISTORY_R2_WRITE_VERSION === "v2"
    ? AQI_R2_HISTORY_DEBUG_PREFIX_V2
    : AQI_R2_HISTORY_PREFIX;
}

export function normalizePollutantCodeForR2Path(pollutantCode: string): string {
  const value = String(pollutantCode || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid pollutant_code for R2 path: ${pollutantCode}`);
  }
  return value;
}

function buildHistoryV2ConnectorPrefix(
  basePrefix: string,
  dayUtc: string,
  connectorId: number,
): string {
  return `${basePrefix}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

function buildHistoryV2PollutantPrefix(
  basePrefix: string,
  dayUtc: string,
  connectorId: number,
  pollutantCode: string,
): string {
  return `${buildHistoryV2ConnectorPrefix(basePrefix, dayUtc, connectorId)}/pollutant_code=${
    normalizePollutantCodeForR2Path(pollutantCode)
  }`;
}

function buildHistoryV2DayManifestKey(basePrefix: string, dayUtc: string): string {
  return `${basePrefix}/day_utc=${dayUtc}/manifest.json`;
}

function buildHistoryV2ConnectorManifestKey(
  basePrefix: string,
  dayUtc: string,
  connectorId: number,
): string {
  return `${buildHistoryV2ConnectorPrefix(basePrefix, dayUtc, connectorId)}/manifest.json`;
}

function buildHistoryV2PollutantManifestKey(
  basePrefix: string,
  dayUtc: string,
  connectorId: number,
  pollutantCode: string,
): string {
  return `${buildHistoryV2PollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode)}/manifest.json`;
}

function buildHistoryV2PartKey(
  basePrefix: string,
  dayUtc: string,
  connectorId: number,
  pollutantCode: string,
  partIndex: number,
): string {
  return `${buildHistoryV2PollutantPrefix(basePrefix, dayUtc, connectorId, pollutantCode)}/part-${
    String(partIndex).padStart(5, "0")
  }.parquet`;
}

function resolveIntegrityProposalStageDir(
  dayUtc: string,
  connectorId: number,
): string | null {
  if (!INTEGRITY_PROPOSAL_MODE) {
    return null;
  }
  const root = (INTEGRITY_PROPOSAL_ROOT || "").trim();
  if (!root) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  return path.join(
    root,
    `day_utc=${normalizedDay}`,
    `connector_id=${connectorId}`,
  );
}

function resolveIntegrityProposalStageFilePath(
  dayUtc: string,
  connectorId: number,
  kind: "obs" | "aqi",
): string | null {
  const stageDir = resolveIntegrityProposalStageDir(dayUtc, connectorId);
  if (!stageDir) {
    return null;
  }
  const fileName = kind === "obs"
    ? "obs_history_rows.json"
    : "aqilevel_rows.json";
  return path.join(stageDir, fileName);
}

function resolveIntegrityProposalEvidenceFilePath(
  dayUtc: string,
  connectorId: number,
): string | null {
  const stageDir = resolveIntegrityProposalStageDir(dayUtc, connectorId);
  return stageDir ? path.join(stageDir, "source-evidence.json") : null;
}

function writeIntegrityProposalStageJson(
  filePath: string,
  value: unknown,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random()
    .toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf8");
  fs.renameSync(tempPath, filePath);
}

// Integrity repair keeps a sparse, run-owned copy of the exact bytes generated
// by the writer.  It is deliberately separate from the row merge stage: the
// coordinator records this local output as a structurally validated proposal.
function writeIntegrityProposalObject(key: string, body: Uint8Array | string): void {
  if (!INTEGRITY_PROPOSAL_MODE || !INTEGRITY_PROPOSAL_ROOT) {
    return;
  }
  const normalizedKey = key.replace(/^\/+/, "");
  if (!normalizedKey || normalizedKey.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe Integrity proposal object key: ${key}`);
  }
  const outputPath = path.join(
    INTEGRITY_PROPOSAL_ROOT,
    "generated-objects",
    ...normalizedKey.split("/"),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, body);
  fs.renameSync(tempPath, outputPath);
}

async function publishOrStageHistoryObject(args: {
  key: string;
  body: Uint8Array | string;
  content_type: string;
}): Promise<{ bytes: number; etag: string | null }> {
  writeIntegrityProposalObject(args.key, args.body);
  if (INTEGRITY_PROPOSAL_MODE) {
    const bytes = typeof args.body === "string"
      ? Buffer.byteLength(args.body, "utf8")
      : args.body.byteLength;
    return { bytes, etag: sha256Hex(args.body) };
  }
  return await r2PutObject({ r2: OBS_R2_CONFIG, ...args });
}

function readObsRowsForConnectorDayFromIntegrityProposalStage(
  dayUtc: string,
  connectorId: number,
): ObsHistoryRow[] | null {
  const filePath = resolveIntegrityProposalStageFilePath(dayUtc, connectorId, "obs");
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Invalid Integrity proposal observation JSON: ${filePath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid Integrity proposal observation rows: ${filePath}`);
  }
  const rows: ObsHistoryRow[] = [];
  for (const rowRaw of parsed) {
    if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) {
      continue;
    }
    const row = rowRaw as Record<string, unknown>;
    const timeseriesId = toSafeInt(row.timeseries_id);
    const observedAt = String(row.observed_at || "").trim();
    const value = toFiniteNumber(row.value);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !observedAt) {
      continue;
    }
    rows.push({
      timeseries_id: timeseriesId,
      station_id: toSafeInt(row.station_id) || null,
      pollutant_code: parsePollutantCode(row.pollutant_code),
      observed_at: observedAt,
      value,
      status: optionalText(row.status),
    });
  }
  return rows;
}

function readAqiRowsForConnectorDayFromIntegrityProposalStage(
  dayUtc: string,
  connectorId: number,
): AqilevelsHistoryRow[] | null {
  const filePath = resolveIntegrityProposalStageFilePath(dayUtc, connectorId, "aqi");
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Invalid Integrity proposal AQI JSON: ${filePath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid Integrity proposal AQI rows: ${filePath}`);
  }
  const rows: AqilevelsHistoryRow[] = [];
  for (const rowRaw of parsed) {
    if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) {
      continue;
    }
    const row = rowRaw as Record<string, unknown>;
    const timeseriesId = toSafeInt(row.timeseries_id);
    const connectorIdValue = toSafeInt(row.connector_id);
    const pollutantCodeRaw = String(row.pollutant_code || "").trim().toLowerCase();
    const timestampHourUtc = String(row.timestamp_hour_utc || "").trim();
    const stationId = toSafeInt(row.station_id);
    if (
      !Number.isInteger(timeseriesId) || timeseriesId <= 0 ||
      !Number.isInteger(connectorIdValue) || connectorIdValue <= 0 ||
      !timestampHourUtc ||
      (pollutantCodeRaw !== "no2" &&
        pollutantCodeRaw !== "pm25" &&
        pollutantCodeRaw !== "pm10")
    ) {
      continue;
    }
    const pollutantCode = pollutantCodeRaw as "no2" | "pm25" | "pm10";
    const hourlyMean = toFiniteNumber(row.hourly_mean_ugm3);
    const rolling24hMean = toFiniteNumber(row.rolling24h_mean_ugm3);
    const daqiInputValue = toSafeNumber(row.daqi_input_value_ugm3) ??
      (pollutantCode === "no2" ? hourlyMean : rolling24hMean);
    const daqiInputAveragingCode = optionalText(row.daqi_input_averaging_code) ??
      daqiAveragingCodeForPollutant(pollutantCode);
    const daqiStatus = optionalText(row.daqi_calculation_status) ??
      (daqiInputValue === null ? "missing_input" : "ok");
    const eaqiInputValue = toSafeNumber(row.eaqi_input_value_ugm3) ?? hourlyMean;
    const eaqiStatus = optionalText(row.eaqi_calculation_status) ??
      (eaqiInputValue === null ? "missing_input" : "ok");
    const daqiIndexLevel = toFiniteNumber(row.daqi_index_level);
    const eaqiIndexLevel = toFiniteNumber(row.eaqi_index_level);
    rows.push({
      timeseries_id: timeseriesId,
      station_id: Number.isInteger(stationId) && stationId > 0 ? stationId : null,
      connector_id: connectorIdValue,
      pollutant_code: pollutantCode,
      timestamp_hour_utc: timestampHourUtc,
      daqi_input_value_ugm3: daqiInputValue,
      daqi_input_averaging_code: daqiInputAveragingCode,
      daqi_source_observation_count: toSafeWholeNumber(row.daqi_source_observation_count) ??
        (daqiInputValue === null ? null : daqiInputAveragingCode === "rolling_24h_mean" ? 24 : toSafeWholeNumber(row.hourly_sample_count)),
      daqi_required_observation_count: toSafeWholeNumber(row.daqi_required_observation_count) ??
        (daqiInputAveragingCode === "rolling_24h_mean" ? 24 : 1),
      daqi_calculation_status: daqiStatus,
      daqi_missing_reason: optionalText(row.daqi_missing_reason) ??
        (daqiStatus === "ok" ? null : daqiStatus),
      eaqi_input_value_ugm3: eaqiInputValue,
      eaqi_input_averaging_code: optionalText(row.eaqi_input_averaging_code) ?? "hourly_mean",
      eaqi_source_observation_count: toSafeWholeNumber(row.eaqi_source_observation_count) ??
        (eaqiInputValue === null ? null : toSafeWholeNumber(row.hourly_sample_count)),
      eaqi_required_observation_count: toSafeWholeNumber(row.eaqi_required_observation_count) ?? 1,
      eaqi_calculation_status: eaqiStatus,
      eaqi_missing_reason: optionalText(row.eaqi_missing_reason) ??
        (eaqiStatus === "ok" ? null : eaqiStatus),
      hourly_mean_ugm3: hourlyMean,
      rolling24h_mean_ugm3: rolling24hMean,
      hourly_sample_count: toFiniteNumber(row.hourly_sample_count),
      daqi_index_level: daqiIndexLevel,
      eaqi_index_level: eaqiIndexLevel,
      no2_hourly_mean_ugm3: pollutantCode === "no2" ? hourlyMean : null,
      pm25_hourly_mean_ugm3: pollutantCode === "pm25" ? hourlyMean : null,
      pm10_hourly_mean_ugm3: pollutantCode === "pm10" ? hourlyMean : null,
      pm25_rolling24h_mean_ugm3: pollutantCode === "pm25" ? rolling24hMean : null,
      pm10_rolling24h_mean_ugm3: pollutantCode === "pm10" ? rolling24hMean : null,
      daqi_no2_index_level: pollutantCode === "no2" ? daqiIndexLevel : null,
      daqi_pm25_rolling24h_index_level: pollutantCode === "pm25" ? daqiIndexLevel : null,
      daqi_pm10_rolling24h_index_level: pollutantCode === "pm10" ? daqiIndexLevel : null,
      eaqi_no2_index_level: pollutantCode === "no2" ? eaqiIndexLevel : null,
      eaqi_pm25_index_level: pollutantCode === "pm25" ? eaqiIndexLevel : null,
      eaqi_pm10_index_level: pollutantCode === "pm10" ? eaqiIndexLevel : null,
      algorithm_version: optionalText(row.algorithm_version) ?? "aqilevels_hourly_v1",
      computed_at_utc: optionalIsoTimestamp(row.computed_at_utc),
      updated_at: optionalIsoTimestamp(row.updated_at),
    });
  }
  return rows;
}

function clearIntegrityProposalStageForConnectorDay(dayUtc: string, connectorId: number): void {
  const stageDir = resolveIntegrityProposalStageDir(dayUtc, connectorId);
  if (!stageDir || !fs.existsSync(stageDir)) {
    return;
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
}

function resolveLocalHistoryPathForR2Key(key: string): string | null {
  const root = (R2_HISTORY_DROPBOX_ROOT || "").trim();
  if (!root) {
    return null;
  }
  const normalizedKey = String(key || "").trim().replace(/^\/+/, "");
  if (!normalizedKey) {
    return null;
  }
  return path.join(root, normalizedKey);
}

function loadLocalHistoryObjectBytesByR2Key(key: string): Uint8Array | null {
  const localPath = resolveLocalHistoryPathForR2Key(key);
  if (!localPath || !fs.existsSync(localPath)) {
    return null;
  }
  return fs.readFileSync(localPath);
}

async function loadHistoryObjectBytesByR2Key(key: string): Promise<{
  body: Uint8Array;
  source: "dropbox" | "r2";
}> {
  const localBody = loadLocalHistoryObjectBytesByR2Key(key);
  if (localBody) {
    return { body: localBody, source: "dropbox" };
  }
  if (INTEGRITY_PROPOSAL_MODE) {
    throw new Error(`integrity combined-local object unavailable: ${key}`);
  }
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
    throw new Error(
      `history object unavailable in local Dropbox backup and R2 credentials are missing: ${key}`,
    );
  }
  const object = await r2GetObject({ r2: OBS_R2_CONFIG, key });
  return { body: object.body, source: "r2" };
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
      status: record.status == null ? null : String(record.status),
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
  query.set("select", "timeseries_id,observed_at,value,status");
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
    const stationIdRaw = record.station_id;
    const stationIdValue = stationIdRaw === null || stationIdRaw === undefined || stationIdRaw === ""
      ? null
      : Number(stationIdRaw);
    const stationId = Number.isInteger(stationIdValue) && Number(stationIdValue) > 0
      ? Math.trunc(Number(stationIdValue))
      : null;
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
      connectorId === null || connectorId <= 0 ||
      !pollutantCode ||
      !Number.isFinite(timestampMs)
    ) {
      continue;
    }

    const timestamp = new Date(timestampMs);
    timestamp.setUTCMinutes(0, 0, 0);

    const hourlyMean = toSafeNumber(record.hourly_mean_ugm3) ??
      (pollutantCode === "no2"
        ? toSafeNumber(record.no2_hourly_mean_ugm3)
        : pollutantCode === "pm25"
        ? toSafeNumber(record.pm25_hourly_mean_ugm3)
        : toSafeNumber(record.pm10_hourly_mean_ugm3));
    const rolling24hMean = pollutantCode === "no2"
      ? null
      : toSafeNumber(record.rolling24h_mean_ugm3) ??
        (pollutantCode === "pm25"
          ? toSafeNumber(record.pm25_rolling24h_mean_ugm3)
          : toSafeNumber(record.pm10_rolling24h_mean_ugm3));
    const daqiInputValue = toSafeNumber(record.daqi_input_value_ugm3) ??
      (pollutantCode === "no2" ? hourlyMean : rolling24hMean);
    const daqiInputAveragingCode = optionalText(record.daqi_input_averaging_code) ??
      daqiAveragingCodeForPollutant(pollutantCode);
    const daqiSourceCount = toSafeWholeNumber(record.daqi_source_observation_count) ??
      (daqiInputValue === null ? null : daqiInputAveragingCode === "rolling_24h_mean" ? 24 : toSafeWholeNumber(record.hourly_sample_count));
    const daqiRequiredCount = toSafeWholeNumber(record.daqi_required_observation_count) ??
      (daqiInputAveragingCode === "rolling_24h_mean" ? 24 : 1);
    const daqiStatus = optionalText(record.daqi_calculation_status) ??
      (daqiInputValue === null ? "missing_input" : "ok");
    const eaqiInputValue = toSafeNumber(record.eaqi_input_value_ugm3) ?? hourlyMean;
    const eaqiInputAveragingCode = optionalText(record.eaqi_input_averaging_code) ?? "hourly_mean";
    const eaqiSourceCount = toSafeWholeNumber(record.eaqi_source_observation_count) ??
      (eaqiInputValue === null ? null : toSafeWholeNumber(record.hourly_sample_count));
    const eaqiRequiredCount = toSafeWholeNumber(record.eaqi_required_observation_count) ?? 1;
    const eaqiStatus = optionalText(record.eaqi_calculation_status) ??
      (eaqiInputValue === null ? "missing_input" : "ok");
    const daqiIndexLevel = toSafeNumber(record.daqi_index_level) ??
      lookupAqiIndexLevel(
        daqiInputValue,
        pollutantCode === "no2"
          ? DAQI_NO2_BREAKPOINTS
          : pollutantCode === "pm25"
          ? DAQI_PM25_ROLLING24H_BREAKPOINTS
          : DAQI_PM10_ROLLING24H_BREAKPOINTS,
      );
    const eaqiIndexLevel = toSafeNumber(record.eaqi_index_level) ??
      lookupAqiIndexLevel(
        eaqiInputValue,
        pollutantCode === "no2"
          ? EAQI_NO2_BREAKPOINTS
          : pollutantCode === "pm25"
          ? EAQI_PM25_BREAKPOINTS
          : EAQI_PM10_BREAKPOINTS,
      );

    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id: stationId,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      timestamp_hour_utc: timestamp.toISOString(),
      daqi_input_value_ugm3: daqiInputValue,
      daqi_input_averaging_code: daqiInputAveragingCode,
      daqi_source_observation_count: daqiSourceCount,
      daqi_required_observation_count: daqiRequiredCount,
      daqi_calculation_status: daqiStatus,
      daqi_missing_reason: optionalText(record.daqi_missing_reason) ??
        (daqiStatus === "ok" ? null : daqiStatus),
      eaqi_input_value_ugm3: eaqiInputValue,
      eaqi_input_averaging_code: eaqiInputAveragingCode,
      eaqi_source_observation_count: eaqiSourceCount,
      eaqi_required_observation_count: eaqiRequiredCount,
      eaqi_calculation_status: eaqiStatus,
      eaqi_missing_reason: optionalText(record.eaqi_missing_reason) ??
        (eaqiStatus === "ok" ? null : eaqiStatus),
      hourly_mean_ugm3: hourlyMean,
      rolling24h_mean_ugm3: rolling24hMean,
      hourly_sample_count: toSafeNumber(record.hourly_sample_count),
      daqi_index_level: daqiIndexLevel,
      eaqi_index_level: eaqiIndexLevel,
      no2_hourly_mean_ugm3: pollutantCode === "no2" ? hourlyMean : null,
      pm25_hourly_mean_ugm3: pollutantCode === "pm25" ? hourlyMean : null,
      pm10_hourly_mean_ugm3: pollutantCode === "pm10" ? hourlyMean : null,
      pm25_rolling24h_mean_ugm3: pollutantCode === "pm25" ? rolling24hMean : null,
      pm10_rolling24h_mean_ugm3: pollutantCode === "pm10" ? rolling24hMean : null,
      daqi_no2_index_level: pollutantCode === "no2" ? daqiIndexLevel : null,
      daqi_pm25_rolling24h_index_level: pollutantCode === "pm25" ? daqiIndexLevel : null,
      daqi_pm10_rolling24h_index_level: pollutantCode === "pm10" ? daqiIndexLevel : null,
      eaqi_no2_index_level: pollutantCode === "no2" ? eaqiIndexLevel : null,
      eaqi_pm25_index_level: pollutantCode === "pm25" ? eaqiIndexLevel : null,
      eaqi_pm10_index_level: pollutantCode === "pm10" ? eaqiIndexLevel : null,
      algorithm_version: optionalText(record.algorithm_version) ?? "aqilevels_hourly_v1",
      computed_at_utc: optionalIsoTimestamp(record.computed_at_utc),
      updated_at: optionalIsoTimestamp(record.updated_at),
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

function aggregateTimeseriesRowCounts(
  entries: Array<{ timeseries_row_counts?: Record<string, number> | null | undefined }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const counts = entry?.timeseries_row_counts;
    if (!counts || typeof counts !== "object") continue;
    for (const [key, value] of Object.entries(counts)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) continue;
      out[key] = (out[key] || 0) + Math.trunc(numeric);
    }
  }
  return out;
}

function stripTimeseriesCountsFromFileEntries(
  entries: ObsHistoryFileEntry[],
): ObsHistoryFileEntry[] {
  return entries.map((entry) => {
    const { timeseries_row_counts: _ignored, ...rest } = entry;
    return rest;
  });
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
  timeseries_row_counts: Record<string, number>;
} {
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  let minObservedAt: string | null = null;
  let maxObservedAt: string | null = null;
  const timeseriesRowCounts: Record<string, number> = {};

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
      const key = String(normalizedTimeseriesId);
      timeseriesRowCounts[key] = (timeseriesRowCounts[key] || 0) + 1;
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
    timeseries_row_counts: timeseriesRowCounts,
  };
}

export function summarizeAqilevelsPartRows(
  rows: AqilevelsHistoryParquetRow[],
): {
  min_timeseries_id: number | null;
  max_timeseries_id: number | null;
  min_timestamp_hour_utc: string | null;
  max_timestamp_hour_utc: string | null;
  pollutant_codes: string[];
  timeseries_row_counts: Record<string, number>;
} {
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  let minTimestampHourUtc: string | null = null;
  let maxTimestampHourUtc: string | null = null;
  const pollutantCodes = new Set<string>();
  const timeseriesRowCounts: Record<string, number> = {};

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
      const key = String(normalizedTimeseriesId);
      timeseriesRowCounts[key] = (timeseriesRowCounts[key] || 0) + 1;
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

    const pollutantCode = parsePollutantCode(row.pollutant_code);
    if (pollutantCode) {
      pollutantCodes.add(pollutantCode);
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    pollutant_codes: Array.from(pollutantCodes).sort((a, b) => a.localeCompare(b)),
    timeseries_row_counts: timeseriesRowCounts,
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
  const manifestFileEntries = stripTimeseriesCountsFromFileEntries(args.fileEntries);
  const parquetObjectKeys = manifestFileEntries.map((entry) => entry.key);
  const totalBytes = manifestFileEntries.reduce(
    (sum, entry) => sum + Number(entry.bytes || 0),
    0,
  );
  const stats = statsFromFileEntries(manifestFileEntries, args.sourceRowCount);
  const timeseriesRowCounts = aggregateTimeseriesRowCounts(args.fileEntries);

  return withManifestHash({
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    min_observed_at: args.minObservedAt,
    max_observed_at: args.maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: manifestFileEntries.length,
    total_bytes: totalBytes,
    files: manifestFileEntries,
    history_schema_name: HISTORY_OBSERVATIONS_SCHEMA_NAME,
    history_schema_version: HISTORY_OBSERVATIONS_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: HISTORY_OBSERVATIONS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    timeseries_row_counts: timeseriesRowCounts,
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

function createObservationV2PollutantManifest(args: {
  dayUtc: string;
  connectorId: number;
  pollutantCode: string;
  runId: string;
  manifestKey: string;
  sourceRowCount: number;
  fileEntries: ObsHistoryFileEntry[];
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.fileEntries.map((entry) => ({
    ...entry,
    pollutant_code: args.pollutantCode,
  }));
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "pollutant",
    domain: "observations",
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    pollutant_code: args.pollutantCode,
    pollutant_codes: [args.pollutantCode],
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    row_count: args.sourceRowCount,
    min_timeseries_id: minFileEntryNumber(files, "min_timeseries_id"),
    max_timeseries_id: maxFileEntryNumber(files, "max_timeseries_id"),
    min_observed_at_utc: minFileEntryString(files, "min_observed_at"),
    max_observed_at_utc: maxFileEntryString(files, "max_observed_at"),
    parquet_object_keys: Array.from(new Set(files.map((entry) => entry.key))).sort(),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: [],
    columns: HISTORY_OBSERVATIONS_COLUMNS_R2_V2,
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...statsFromFileEntries(files, args.sourceRowCount),
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function createObservationV2ConnectorManifest(args: {
  dayUtc: string;
  connectorId: number;
  runId: string;
  manifestKey: string;
  pollutantManifests: Array<Record<string, unknown>>;
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.pollutantManifests.flatMap((manifest) =>
    Array.isArray(manifest.files) ? manifest.files as ObsHistoryFileEntry[] : []
  );
  const pollutantCodes = Array.from(new Set(args.pollutantManifests
    .map((manifest) => String(manifest.pollutant_code || "").trim())
    .filter(Boolean))).sort();
  const totalRows = args.pollutantManifests.reduce((sum, manifest) => sum + toSafeInt(manifest.source_row_count), 0);
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const childManifests = args.pollutantManifests.map((manifest) => ({
    pollutant_code: manifest.pollutant_code,
    manifest_key: manifest.manifest_key,
    manifest_hash: manifest.manifest_hash,
    source_row_count: manifest.source_row_count,
    row_count: manifest.row_count,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    min_timeseries_id: manifest.min_timeseries_id ?? null,
    max_timeseries_id: manifest.max_timeseries_id ?? null,
    min_observed_at_utc: manifest.min_observed_at_utc ?? null,
    max_observed_at_utc: manifest.max_observed_at_utc ?? null,
  }));
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "connector",
    domain: "observations",
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    pollutant_code: null,
    pollutant_codes: pollutantCodes,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: totalRows,
    row_count: totalRows,
    min_timeseries_id: minFileEntryNumber(files, "min_timeseries_id"),
    max_timeseries_id: maxFileEntryNumber(files, "max_timeseries_id"),
    min_observed_at_utc: minFileEntryString(files, "min_observed_at"),
    max_observed_at_utc: maxFileEntryString(files, "max_observed_at"),
    parquet_object_keys: Array.from(new Set(files.map((entry) => entry.key))).sort(),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: childManifests,
    pollutant_manifests: childManifests,
    columns: HISTORY_OBSERVATIONS_COLUMNS_R2_V2,
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...statsFromFileEntries(files, totalRows),
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

export function createAqiConnectorManifest(args: {
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
  const manifestFileEntries = stripTimeseriesCountsFromFileEntries(args.fileEntries);
  const parquetObjectKeys = manifestFileEntries.map((entry) => entry.key);
  const totalBytes = manifestFileEntries.reduce(
    (sum, entry) => sum + Number(entry.bytes || 0),
    0,
  );
  let minTimeseriesId: number | null = null;
  let maxTimeseriesId: number | null = null;
  for (const entry of manifestFileEntries) {
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
  const stats = statsFromFileEntries(manifestFileEntries, args.sourceRowCount);
  const timeseriesRowCounts = aggregateTimeseriesRowCounts(args.fileEntries);

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
    file_count: manifestFileEntries.length,
    total_bytes: totalBytes,
    files: manifestFileEntries,
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...stats,
    timeseries_row_counts: timeseriesRowCounts,
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
      pollutant_codes: Array.isArray(entry.pollutant_codes)
        ? entry.pollutant_codes
        : null,
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

function minFileEntryString(
  entries: ObsHistoryFileEntry[],
  fieldName: keyof ObsHistoryFileEntry,
): string | null {
  let out: string | null = null;
  for (const entry of entries) {
    const value = typeof entry[fieldName] === "string"
      ? String(entry[fieldName])
      : null;
    if (value && (!out || value < out)) out = value;
  }
  return out;
}

function maxFileEntryString(
  entries: ObsHistoryFileEntry[],
  fieldName: keyof ObsHistoryFileEntry,
): string | null {
  let out: string | null = null;
  for (const entry of entries) {
    const value = typeof entry[fieldName] === "string"
      ? String(entry[fieldName])
      : null;
    if (value && (!out || value > out)) out = value;
  }
  return out;
}

function minFileEntryNumber(
  entries: ObsHistoryFileEntry[],
  fieldName: keyof ObsHistoryFileEntry,
): number | null {
  let out: number | null = null;
  for (const entry of entries) {
    const value = Number(entry[fieldName]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const normalized = Math.trunc(value);
    out = out === null ? normalized : Math.min(out, normalized);
  }
  return out;
}

function maxFileEntryNumber(
  entries: ObsHistoryFileEntry[],
  fieldName: keyof ObsHistoryFileEntry,
): number | null {
  let out: number | null = null;
  for (const entry of entries) {
    const value = Number(entry[fieldName]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const normalized = Math.trunc(value);
    out = out === null ? normalized : Math.max(out, normalized);
  }
  return out;
}

function historyV2AqiColumns(profile: "data" | "debug"): readonly string[] {
  return profile === "data"
    ? HISTORY_AQILEVELS_HOURLY_DATA_COLUMNS_R2_V2
    : HISTORY_AQILEVELS_HOURLY_DEBUG_COLUMNS_R2_V2;
}

export function createAqiV2PollutantManifest(args: {
  profile: "data" | "debug";
  dayUtc: string;
  connectorId: number;
  pollutantCode: "no2" | "pm25" | "pm10";
  runId: string;
  manifestKey: string;
  sourceRowCount: number;
  fileEntries: ObsHistoryFileEntry[];
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const filesWithCounts = args.fileEntries.map((entry) => ({
    ...entry,
    pollutant_code: args.pollutantCode,
  }));
  const files = stripTimeseriesCountsFromFileEntries(filesWithCounts);
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const timeseriesRowCounts = aggregateTimeseriesRowCounts(filesWithCounts);
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "pollutant",
    domain: "aqilevels",
    grain: "hourly",
    profile: args.profile,
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    pollutant_code: args.pollutantCode,
    pollutant_codes: [args.pollutantCode],
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: args.sourceRowCount,
    row_count: args.sourceRowCount,
    min_timeseries_id: minFileEntryNumber(files, "min_timeseries_id"),
    max_timeseries_id: maxFileEntryNumber(files, "max_timeseries_id"),
    min_timestamp_hour_utc: minFileEntryString(files, "min_timestamp_hour_utc"),
    max_timestamp_hour_utc: maxFileEntryString(files, "max_timestamp_hour_utc"),
    parquet_object_keys: Array.from(new Set(files.map((entry) => entry.key))).sort(),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: [],
    columns: historyV2AqiColumns(args.profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...statsFromFileEntries(files, args.sourceRowCount),
    timeseries_row_counts: timeseriesRowCounts,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

export function createAqiV2ConnectorManifest(args: {
  profile: "data" | "debug";
  dayUtc: string;
  connectorId: number;
  runId: string;
  manifestKey: string;
  pollutantManifests: Array<Record<string, unknown>>;
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.pollutantManifests.flatMap((manifest) =>
    Array.isArray(manifest.files) ? manifest.files as ObsHistoryFileEntry[] : []
  );
  const pollutantCodes = Array.from(new Set(args.pollutantManifests
    .map((manifest) => String(manifest.pollutant_code || "").trim())
    .filter(Boolean))).sort();
  const totalRows = args.pollutantManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const timeseriesRowCounts = aggregateTimeseriesRowCounts(
    args.pollutantManifests as Array<{ timeseries_row_counts?: Record<string, number> | null | undefined }>,
  );
  const childManifests = args.pollutantManifests.map((manifest) => ({
    pollutant_code: manifest.pollutant_code,
    manifest_key: manifest.manifest_key,
    manifest_hash: manifest.manifest_hash,
    source_row_count: manifest.source_row_count,
    row_count: manifest.row_count,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    min_timeseries_id: manifest.min_timeseries_id ?? null,
    max_timeseries_id: manifest.max_timeseries_id ?? null,
    min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null,
    max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null,
  }));
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "connector",
    domain: "aqilevels",
    grain: "hourly",
    profile: args.profile,
    day_utc: args.dayUtc,
    connector_id: args.connectorId,
    pollutant_code: null,
    pollutant_codes: pollutantCodes,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: totalRows,
    row_count: totalRows,
    min_timeseries_id: minFileEntryNumber(files, "min_timeseries_id"),
    max_timeseries_id: maxFileEntryNumber(files, "max_timeseries_id"),
    min_timestamp_hour_utc: minFileEntryString(files, "min_timestamp_hour_utc"),
    max_timestamp_hour_utc: maxFileEntryString(files, "max_timestamp_hour_utc"),
    parquet_object_keys: Array.from(new Set(files.map((entry) => entry.key))).sort(),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: childManifests,
    pollutant_manifests: childManifests,
    columns: historyV2AqiColumns(args.profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...statsFromFileEntries(files, totalRows),
    timeseries_row_counts: timeseriesRowCounts,
    backed_up_at_utc: args.backedUpAtUtc,
  });
}

function createAqiV2DayManifest(args: {
  profile: "data" | "debug";
  dayUtc: string;
  runId: string;
  manifestKey: string;
  connectorManifests: Array<Record<string, unknown>>;
  writerGitSha: string | null;
  backedUpAtUtc: string;
}) {
  const files = args.connectorManifests.flatMap((manifest) =>
    Array.isArray(manifest.files) ? manifest.files as ObsHistoryFileEntry[] : []
  );
  const connectorIds = args.connectorManifests
    .map((manifest) => Number(manifest.connector_id))
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);
  const pollutantCodes = Array.from(new Set(args.connectorManifests
    .flatMap((manifest) => Array.isArray(manifest.pollutant_codes) ? manifest.pollutant_codes : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))).sort();
  const totalRows = args.connectorManifests.reduce(
    (sum, manifest) => sum + toSafeInt(manifest.source_row_count),
    0,
  );
  const totalBytes = files.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const childManifests = args.connectorManifests.map((manifest) => ({
    connector_id: manifest.connector_id,
    manifest_key: manifest.manifest_key,
    manifest_hash: manifest.manifest_hash,
    source_row_count: manifest.source_row_count,
    row_count: manifest.row_count,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    pollutant_codes: manifest.pollutant_codes,
    min_timeseries_id: manifest.min_timeseries_id ?? null,
    max_timeseries_id: manifest.max_timeseries_id ?? null,
    min_timestamp_hour_utc: manifest.min_timestamp_hour_utc ?? null,
    max_timestamp_hour_utc: manifest.max_timestamp_hour_utc ?? null,
  }));
  return withManifestHash({
    manifest_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_schema_version: HISTORY_R2_V2_SCHEMA_VERSION,
    history_version: "v2",
    manifest_kind: "day",
    domain: "aqilevels",
    grain: "hourly",
    profile: args.profile,
    day_utc: args.dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    pollutant_code: null,
    pollutant_codes: pollutantCodes,
    run_id: args.runId,
    manifest_key: args.manifestKey,
    source_row_count: totalRows,
    row_count: totalRows,
    min_timeseries_id: minFileEntryNumber(files, "min_timeseries_id"),
    max_timeseries_id: maxFileEntryNumber(files, "max_timeseries_id"),
    min_timestamp_hour_utc: minFileEntryString(files, "min_timestamp_hour_utc"),
    max_timestamp_hour_utc: maxFileEntryString(files, "max_timestamp_hour_utc"),
    parquet_object_keys: Array.from(new Set(files.map((entry) => entry.key))).sort(),
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    child_manifests: childManifests,
    connector_manifests: childManifests,
    columns: historyV2AqiColumns(args.profile),
    writer_version: HISTORY_R2_V2_WRITER_VERSION,
    writer_git_sha: args.writerGitSha,
    ...statsFromFileEntries(files, totalRows),
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
    status: rows.map((row) => row.status ?? null),
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
  const int32Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Int32());
  const float64Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Float64());
  const textVector = (values: Array<string | null>) =>
    arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values: Array<Date | null>) =>
    arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
    tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
  }).tableFromArrays({
    connector_id: int32Vector(rows.map((row) => row.connector_id)),
    station_id: int32Vector(rows.map((row) => row.station_id)),
    timeseries_id: int32Vector(rows.map((row) => row.timeseries_id)),
    pollutant_code: textVector(rows.map((row) => row.pollutant_code)),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => row.daqi_input_value_ugm3)),
    daqi_input_averaging_code: textVector(rows.map((row) => row.daqi_input_averaging_code)),
    daqi_index_level: int32Vector(rows.map((row) => row.daqi_index_level)),
    daqi_source_observation_count: int32Vector(rows.map((row) => row.daqi_source_observation_count)),
    daqi_required_observation_count: int32Vector(rows.map((row) => row.daqi_required_observation_count)),
    daqi_calculation_status: textVector(rows.map((row) => row.daqi_calculation_status)),
    daqi_missing_reason: textVector(rows.map((row) => row.daqi_missing_reason)),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => row.eaqi_input_value_ugm3)),
    eaqi_input_averaging_code: textVector(rows.map((row) => row.eaqi_input_averaging_code)),
    eaqi_index_level: int32Vector(rows.map((row) => row.eaqi_index_level)),
    eaqi_source_observation_count: int32Vector(rows.map((row) => row.eaqi_source_observation_count)),
    eaqi_required_observation_count: int32Vector(rows.map((row) => row.eaqi_required_observation_count)),
    eaqi_calculation_status: textVector(rows.map((row) => row.eaqi_calculation_status)),
    eaqi_missing_reason: textVector(rows.map((row) => row.eaqi_missing_reason)),
    hourly_sample_count: int32Vector(rows.map((row) => row.hourly_sample_count)),
    algorithm_version: textVector(rows.map((row) => row.algorithm_version)),
    computed_at_utc: timestampVector(rows.map((row) =>
      row.computed_at_utc ? new Date(row.computed_at_utc) : null
    )),
    hourly_mean_ugm3: float64Vector(rows.map((row) => row.hourly_mean_ugm3)),
    rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.rolling24h_mean_ugm3)),
    no2_hourly_mean_ugm3: float64Vector(rows.map((row) => row.no2_hourly_mean_ugm3)),
    pm25_hourly_mean_ugm3: float64Vector(rows.map((row) => row.pm25_hourly_mean_ugm3)),
    pm10_hourly_mean_ugm3: float64Vector(rows.map((row) => row.pm10_hourly_mean_ugm3)),
    pm25_rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.pm25_rolling24h_mean_ugm3)),
    pm10_rolling24h_mean_ugm3: float64Vector(rows.map((row) => row.pm10_rolling24h_mean_ugm3)),
    daqi_no2_index_level: int32Vector(rows.map((row) => row.daqi_no2_index_level)),
    daqi_pm25_rolling24h_index_level: int32Vector(rows.map((row) => row.daqi_pm25_rolling24h_index_level)),
    daqi_pm10_rolling24h_index_level: int32Vector(rows.map((row) => row.daqi_pm10_rolling24h_index_level)),
    eaqi_no2_index_level: int32Vector(rows.map((row) => row.eaqi_no2_index_level)),
    eaqi_pm25_index_level: int32Vector(rows.map((row) => row.eaqi_pm25_index_level)),
    eaqi_pm10_index_level: int32Vector(rows.map((row) => row.eaqi_pm10_index_level)),
    updated_at: timestampVector(rows.map((row) =>
      row.updated_at ? new Date(row.updated_at) : null
    )),
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
      AQI_R2_ROW_GROUP_SIZE,
      HISTORY_AQILEVELS_WRITER_VERSION,
    ),
  );
}

function writeArrowTableToParquet(table: unknown, writerProperties: unknown): Uint8Array {
  const wasmTable = (parquetWasm as unknown as {
    Table: { fromIPCStream: (bytes: Uint8Array) => unknown };
  }).Table.fromIPCStream(
    (arrow as unknown as {
      tableToIPC: (table: unknown, mode: "stream") => Uint8Array;
    }).tableToIPC(table, "stream"),
  );
  return (parquetWasm as unknown as {
    writeParquet: (table: unknown, writerProperties: unknown) => Uint8Array;
  }).writeParquet(wasmTable, writerProperties);
}

function rowsToObservationV2ParquetBuffer(rows: ObsHistoryV2ParquetRow[]): Uint8Array {
  ensureParquetWasmInitialized();
  const int32Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Int32());
  const textVector = (values: Array<string | null>) =>
    arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values: Array<Date | null>) =>
    arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
  }).tableFromArrays({
    connector_id: int32Vector(rows.map((row) => row.connector_id)),
    station_id: int32Vector(rows.map((row) => row.station_id)),
    timeseries_id: int32Vector(rows.map((row) => row.timeseries_id)),
    pollutant_code: textVector(rows.map((row) => row.pollutant_code)),
    observed_at_utc: timestampVector(rows.map((row) => new Date(row.observed_at))),
    value: rows.map((row) => row.value === null || row.value === undefined ? null : Number(row.value)),
    status: textVector(rows.map((row) => row.status ?? null)),
  });
  return writeArrowTableToParquet(
    table,
    parquetWriterProperties(OBS_R2_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
  );
}

function rowsToAqiDataV2ParquetBuffer(rows: AqilevelsHistoryParquetRow[]): Uint8Array {
  ensureParquetWasmInitialized();
  const int32Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Int32());
  const textVector = (values: Array<string | null>) =>
    arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values: Array<Date | null>) =>
    arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
  }).tableFromArrays({
    connector_id: int32Vector(rows.map((row) => row.connector_id)),
    station_id: int32Vector(rows.map((row) => row.station_id)),
    timeseries_id: int32Vector(rows.map((row) => row.timeseries_id)),
    pollutant_code: textVector(rows.map((row) => row.pollutant_code)),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_index_level: int32Vector(rows.map((row) => row.daqi_index_level)),
    eaqi_index_level: int32Vector(rows.map((row) => row.eaqi_index_level)),
    daqi_calculation_status: textVector(rows.map((row) => row.daqi_calculation_status)),
    daqi_missing_reason: textVector(rows.map((row) => row.daqi_missing_reason)),
    eaqi_calculation_status: textVector(rows.map((row) => row.eaqi_calculation_status)),
    eaqi_missing_reason: textVector(rows.map((row) => row.eaqi_missing_reason)),
  });
  return writeArrowTableToParquet(
    table,
    parquetWriterProperties(AQI_R2_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
  );
}

function rowsToAqiDebugV2ParquetBuffer(rows: AqilevelsHistoryParquetRow[]): Uint8Array {
  ensureParquetWasmInitialized();
  const int32Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Int32());
  const float64Vector = (values: Array<number | null>) =>
    arrow.vectorFromArray(values, new arrow.Float64());
  const textVector = (values: Array<string | null>) =>
    arrow.vectorFromArray(values, new arrow.Utf8());
  const timestampVector = (values: Array<Date | null>) =>
    arrow.vectorFromArray(values, new arrow.TimestampMillisecond());
  const table = (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => unknown;
  }).tableFromArrays({
    connector_id: int32Vector(rows.map((row) => row.connector_id)),
    station_id: int32Vector(rows.map((row) => row.station_id)),
    timeseries_id: int32Vector(rows.map((row) => row.timeseries_id)),
    pollutant_code: textVector(rows.map((row) => row.pollutant_code)),
    timestamp_hour_utc: timestampVector(rows.map((row) => new Date(row.timestamp_hour_utc))),
    daqi_input_value_ugm3: float64Vector(rows.map((row) => row.daqi_input_value_ugm3)),
    daqi_input_averaging_code: textVector(rows.map((row) => row.daqi_input_averaging_code)),
    daqi_index_level: int32Vector(rows.map((row) => row.daqi_index_level)),
    daqi_source_observation_count: int32Vector(rows.map((row) => row.daqi_source_observation_count)),
    daqi_required_observation_count: int32Vector(rows.map((row) => row.daqi_required_observation_count)),
    daqi_calculation_status: textVector(rows.map((row) => row.daqi_calculation_status)),
    daqi_missing_reason: textVector(rows.map((row) => row.daqi_missing_reason)),
    eaqi_input_value_ugm3: float64Vector(rows.map((row) => row.eaqi_input_value_ugm3)),
    eaqi_input_averaging_code: textVector(rows.map((row) => row.eaqi_input_averaging_code)),
    eaqi_index_level: int32Vector(rows.map((row) => row.eaqi_index_level)),
    eaqi_source_observation_count: int32Vector(rows.map((row) => row.eaqi_source_observation_count)),
    eaqi_required_observation_count: int32Vector(rows.map((row) => row.eaqi_required_observation_count)),
    eaqi_calculation_status: textVector(rows.map((row) => row.eaqi_calculation_status)),
    eaqi_missing_reason: textVector(rows.map((row) => row.eaqi_missing_reason)),
    hourly_sample_count: int32Vector(rows.map((row) => row.hourly_sample_count)),
    algorithm_version: textVector(rows.map((row) => row.algorithm_version)),
    computed_at_utc: timestampVector(rows.map((row) => row.computed_at_utc ? new Date(row.computed_at_utc) : null)),
  });
  return writeArrowTableToParquet(
    table,
    parquetWriterProperties(AQI_R2_ROW_GROUP_SIZE, HISTORY_R2_V2_WRITER_VERSION),
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
  const keys = entries.map((entry: { key?: string }) => String(entry.key || "").trim()).filter(
    Boolean,
  );
  try {
    const deleted = await deleteR2Keys(keys);
    return deleted;
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
  const localBody = loadLocalHistoryObjectBytesByR2Key(key);
  if (!localBody && INTEGRITY_PROPOSAL_MODE) return null;
  if (!localBody) {
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
    if (!head.exists) return null;
  }
  const body = localBody || (await r2GetObject({ r2: OBS_R2_CONFIG, key })).body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
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
          : typeof item.min_observed_at_utc === "string"
          ? item.min_observed_at_utc
          : null,
        max_observed_at: typeof item.max_observed_at === "string"
          ? item.max_observed_at
          : typeof item.max_observed_at_utc === "string"
          ? item.max_observed_at_utc
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
      : typeof record.min_observed_at_utc === "string"
      ? record.min_observed_at_utc
      : null,
    max_observed_at: typeof record.max_observed_at === "string"
      ? record.max_observed_at
      : typeof record.max_observed_at_utc === "string"
      ? record.max_observed_at_utc
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
  const key = buildObsDayManifestKey(dayUtc);
  const localBody = loadLocalHistoryObjectBytesByR2Key(key);
  if (localBody) {
    const parsed = JSON.parse(new TextDecoder().decode(localBody));
    const resolved = extractConnectorIdsFromHistoryDayManifest(
      parsed as Record<string, unknown>,
    );
    r2ObservationConnectorIdsByDayCache.set(dayUtc, resolved);
    return resolved;
  }
  if (INTEGRITY_PROPOSAL_MODE || !hasRequiredR2Config(OBS_R2_CONFIG)) {
    r2ObservationConnectorIdsByDayCache.set(dayUtc, []);
    return [];
  }
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
      timeseries_row_counts: partSummary.timeseries_row_counts,
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
        status: (row as Record<string, unknown>).status == null
          ? null
          : String((row as Record<string, unknown>).status),
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
  return await loadAqiConnectorManifestByKey(dayUtc, connectorId, key);
}

async function loadAqiConnectorManifestByKey(
  dayUtc: string,
  connectorId: number,
  key: string,
): Promise<AqilevelsConnectorManifest | null> {
  const localBody = loadLocalHistoryObjectBytesByR2Key(key);
  if (!localBody && INTEGRITY_PROPOSAL_MODE) return null;
  if (!localBody) {
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key });
    if (!head.exists) return null;
  }
  const body = localBody || (await r2GetObject({ r2: OBS_R2_CONFIG, key })).body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
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
      pollutant_codes: partSummary.pollutant_codes,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
      timeseries_row_counts: partSummary.timeseries_row_counts,
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
        daqi_input_value_ugm3: row.daqi_input_value_ugm3,
        daqi_input_averaging_code: row.daqi_input_averaging_code,
        daqi_index_level: row.daqi_index_level,
        daqi_source_observation_count: row.daqi_source_observation_count,
        daqi_required_observation_count: row.daqi_required_observation_count,
        daqi_calculation_status: row.daqi_calculation_status,
        daqi_missing_reason: row.daqi_missing_reason,
        eaqi_input_value_ugm3: row.eaqi_input_value_ugm3,
        eaqi_input_averaging_code: row.eaqi_input_averaging_code,
        eaqi_index_level: row.eaqi_index_level,
        eaqi_source_observation_count: row.eaqi_source_observation_count,
        eaqi_required_observation_count: row.eaqi_required_observation_count,
        eaqi_calculation_status: row.eaqi_calculation_status,
        eaqi_missing_reason: row.eaqi_missing_reason,
        hourly_sample_count: row.hourly_sample_count,
        algorithm_version: row.algorithm_version,
        computed_at_utc: row.computed_at_utc,
        hourly_mean_ugm3: row.hourly_mean_ugm3,
        rolling24h_mean_ugm3: row.rolling24h_mean_ugm3,
        no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
        pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
        pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
        pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
        pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
        daqi_no2_index_level: row.daqi_no2_index_level,
        daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level,
        daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level,
        eaqi_no2_index_level: row.eaqi_no2_index_level,
        eaqi_pm25_index_level: row.eaqi_pm25_index_level,
        eaqi_pm10_index_level: row.eaqi_pm10_index_level,
        updated_at: row.updated_at,
      });
      if (parquetRowsBuffer.length >= AQI_R2_PART_MAX_ROWS) {
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
  objects_staged_local?: number;
  manifest_key: string;
  connector_manifest: ObsConnectorManifest & Record<string, unknown>;
  rows_with_missing_pollutant_code?: number;
  rows_skipped_missing_pollutant_code?: number;
  example_missing_pollutant_rows?: MissingPollutantExampleRow[];
  pollutant_codes_written?: string[];
}> {
  if (HISTORY_R2_WRITE_VERSION === "v2") {
    return await exportObsConnectorRowsToR2V2(args);
  }

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
      status: row.status ?? null,
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
      timeseries_row_counts: partSummary.timeseries_row_counts,
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

type MissingPollutantExampleRow = {
  timeseries_id: number | null;
  station_id: number | null;
  observed_at: string | null;
  source_parameter: string | null;
};

type ObservationPollutantClassification = {
  valid_rows: ObsHistoryRow[];
  missing_pollutant_rows: ObsHistoryRow[];
  rows_with_missing_pollutant_code: number;
  rows_skipped_missing_pollutant_code: number;
  example_missing_pollutant_rows: MissingPollutantExampleRow[];
  pollutant_codes_written: string[];
};

function safeMissingPollutantExample(row: ObsHistoryRow): MissingPollutantExampleRow {
  const sourceParameter = typeof (row as Record<string, unknown>).source_parameter === "string"
    ? String((row as Record<string, unknown>).source_parameter).trim() || null
    : null;
  return {
    timeseries_id: Number.isInteger(Number(row.timeseries_id)) ? Math.trunc(Number(row.timeseries_id)) : null,
    station_id: Number.isInteger(Number(row.station_id)) ? Math.trunc(Number(row.station_id)) : null,
    observed_at: typeof row.observed_at === "string" && row.observed_at ? row.observed_at : null,
    source_parameter: sourceParameter,
  };
}

export function classifyObservationRowsForV2PollutantPartitions(
  rows: ObsHistoryRow[],
): ObservationPollutantClassification {
  const validRows: ObsHistoryRow[] = [];
  const missingPollutantRows: ObsHistoryRow[] = [];
  const pollutantCodes = new Set<string>();

  for (const row of rows) {
    try {
      const pollutantCode = normalizePollutantCodeForR2Path(String(row.pollutant_code || ""));
      validRows.push({ ...row, pollutant_code: pollutantCode as SourcePollutantCode });
      pollutantCodes.add(pollutantCode);
    } catch (_error) {
      missingPollutantRows.push(row);
    }
  }

  return {
    valid_rows: validRows,
    missing_pollutant_rows: missingPollutantRows,
    rows_with_missing_pollutant_code: missingPollutantRows.length,
    rows_skipped_missing_pollutant_code: missingPollutantRows.length,
    example_missing_pollutant_rows: missingPollutantRows.slice(0, 5).map(safeMissingPollutantExample),
    pollutant_codes_written: Array.from(pollutantCodes).sort((a, b) => a.localeCompare(b)),
  };
}

export function assertIntegrityProposalPollutantCompleteness(
  classification: ObservationPollutantClassification,
  context: { day_utc: string; connector_id: number },
): void {
  if (classification.rows_skipped_missing_pollutant_code <= 0) return;
  throw new Error(
    `Integrity connector-day proposal contains observation rows without a canonical pollutant: ` +
      `day_utc=${context.day_utc} connector_id=${context.connector_id} ` +
      `rows=${classification.rows_skipped_missing_pollutant_code} ` +
      `examples=${JSON.stringify(classification.example_missing_pollutant_rows.slice(0, 10))}`,
  );
}

function groupObservationRowsByPollutant(
  rows: ObsHistoryRow[],
): Map<string, ObsHistoryRow[]> {
  const grouped = new Map<string, ObsHistoryRow[]>();
  for (const row of rows) {
    const pollutantCode = normalizePollutantCodeForR2Path(String(row.pollutant_code || ""));
    if (!grouped.has(pollutantCode)) grouped.set(pollutantCode, []);
    grouped.get(pollutantCode)?.push(row);
  }
  return grouped;
}

type ObsV2ExportResult = {
  rows_read: number;
  objects_written_r2: number;
  objects_staged_local?: number;
  manifest_key: string;
  connector_manifest: ObsConnectorManifest & Record<string, unknown>;
  rows_with_missing_pollutant_code: number;
  rows_skipped_missing_pollutant_code: number;
  example_missing_pollutant_rows: MissingPollutantExampleRow[];
  pollutant_codes_written: string[];
};

async function exportObsConnectorRowsToR2V2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
  rows: ObsHistoryRow[];
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  objects_staged_local?: number;
  manifest_key: string;
  connector_manifest: ObsConnectorManifest & Record<string, unknown>;
  rows_with_missing_pollutant_code: number;
  rows_skipped_missing_pollutant_code: number;
  example_missing_pollutant_rows: MissingPollutantExampleRow[];
  pollutant_codes_written: string[];
}> {
  // Integrity prepares the complete canonical connector-day locally. Remote
  // deletion and publication are owned by the coordinator only after every
  // local object has passed structural validation.
  if (FORCE_REPLACE && !INTEGRITY_PROPOSAL_MODE) {
    await deleteR2Prefix(
      buildHistoryV2ConnectorPrefix(
        OBS_R2_HISTORY_PREFIX_V2,
        args.day_utc,
        args.connector_id,
      ),
    );
  }

  const rowsForWrite = args.rows;
  const classification = classifyObservationRowsForV2PollutantPartitions(rowsForWrite);
  if (INTEGRITY_PROPOSAL_MODE) {
    assertIntegrityProposalPollutantCompleteness(classification, args);
  }
  if (classification.rows_skipped_missing_pollutant_code > 0) {
    logStructured("warning", "source_to_r2_v2_observations_missing_pollutant_code_rows_skipped", {
      run_id: args.run_id,
      day_utc: args.day_utc,
      connector_id: args.connector_id,
      rows_read: rowsForWrite.length,
      rows_with_missing_pollutant_code: classification.rows_with_missing_pollutant_code,
      rows_skipped_missing_pollutant_code: classification.rows_skipped_missing_pollutant_code,
      example_missing_pollutant_rows: classification.example_missing_pollutant_rows,
    });
  }
  if (rowsForWrite.length > 0 && classification.valid_rows.length === 0) {
    throw new Error(
      `No valid pollutant_code rows for v2 observation R2 write: day_utc=${args.day_utc} connector_id=${args.connector_id} rows_read=${rowsForWrite.length} rows_skipped_missing_pollutant_code=${classification.rows_skipped_missing_pollutant_code}`,
    );
  }

  const sortedRows = [...classification.valid_rows].sort((left, right) => {
    const leftPollutant = String(left.pollutant_code || "");
    const rightPollutant = String(right.pollutant_code || "");
    if (leftPollutant !== rightPollutant) return leftPollutant.localeCompare(rightPollutant);
    if (left.timeseries_id !== right.timeseries_id) return left.timeseries_id - right.timeseries_id;
    if (left.observed_at < right.observed_at) return -1;
    if (left.observed_at > right.observed_at) return 1;
    return 0;
  });
  const pollutantGroups = groupObservationRowsByPollutant(sortedRows);
  const pollutantManifests: Array<Record<string, unknown>> = [];
  let objectsWritten = 0;

  for (const [pollutantCode, pollutantRows] of Array.from(pollutantGroups.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const fileEntries: ObsHistoryFileEntry[] = [];
    const rowChunks = chunkRows(pollutantRows, OBS_R2_PART_MAX_ROWS);
    for (let partIndex = 0; partIndex < rowChunks.length; partIndex += 1) {
      const chunk = rowChunks[partIndex];
      if (!chunk.length) continue;
      const parquetRows: ObsHistoryV2ParquetRow[] = chunk.map((row) => ({
        connector_id: args.connector_id,
        station_id: row.station_id ?? null,
        timeseries_id: row.timeseries_id,
        pollutant_code: pollutantCode,
        observed_at: row.observed_at,
        value: row.value,
        status: row.status ?? null,
      }));
      const partSummary = summarizeObservationPartRows(parquetRows);
      const partKey = buildHistoryV2PartKey(
        OBS_R2_HISTORY_PREFIX_V2,
        args.day_utc,
        args.connector_id,
        pollutantCode,
        partIndex,
      );
      const parquetBuffer = rowsToObservationV2ParquetBuffer(parquetRows);
      const putResult = await publishOrStageHistoryObject({
        key: partKey,
        body: parquetBuffer,
        content_type: "application/octet-stream",
      });
      const contentSha256 = sha256Hex(parquetBuffer);
      let verifiedBytes = parquetBuffer.byteLength;
      let verifiedEtag = putResult.etag;
      if (!INTEGRITY_PROPOSAL_MODE) {
        const actual = await r2GetObject({ r2: OBS_R2_CONFIG, key: partKey });
        if (actual.bytes !== parquetBuffer.byteLength || sha256Hex(actual.body) !== contentSha256) {
          throw new Error(`v2 observation parquet GET verification failed: ${partKey}`);
        }
        verifiedBytes = actual.bytes;
        verifiedEtag = actual.etag || putResult.etag;
      }
      fileEntries.push({
        key: partKey,
        row_count: chunk.length,
        bytes: Math.trunc(verifiedBytes),
        etag_or_hash: verifiedEtag || contentSha256,
        pollutant_codes: [pollutantCode],
        min_timeseries_id: partSummary.min_timeseries_id,
        max_timeseries_id: partSummary.max_timeseries_id,
        min_observed_at: partSummary.min_observed_at,
        max_observed_at: partSummary.max_observed_at,
        timeseries_row_counts: partSummary.timeseries_row_counts,
      });
      objectsWritten += 1;
    }
    const manifestKey = buildHistoryV2PollutantManifestKey(
      OBS_R2_HISTORY_PREFIX_V2,
      args.day_utc,
      args.connector_id,
      pollutantCode,
    );
    const pollutantManifest = createObservationV2PollutantManifest({
      dayUtc: args.day_utc,
      connectorId: args.connector_id,
      pollutantCode,
      runId: args.run_id,
      manifestKey,
      sourceRowCount: pollutantRows.length,
      fileEntries,
      writerGitSha: OBS_R2_WRITER_GIT_SHA,
      backedUpAtUtc: nowIso(),
    });
    await publishOrStageHistoryObject({
      key: manifestKey,
      body: encodeJsonBody(pollutantManifest),
      content_type: "application/json",
    });
    objectsWritten += 1;
    pollutantManifests.push(pollutantManifest);
  }

  const manifestKey = buildHistoryV2ConnectorManifestKey(
    OBS_R2_HISTORY_PREFIX_V2,
    args.day_utc,
    args.connector_id,
  );
  const connectorManifest = createObservationV2ConnectorManifest({
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey,
    pollutantManifests,
    writerGitSha: OBS_R2_WRITER_GIT_SHA,
    backedUpAtUtc: nowIso(),
  }) as unknown as ObsConnectorManifest & Record<string, unknown>;
  connectorManifest.rows_with_missing_pollutant_code = classification.rows_with_missing_pollutant_code;
  connectorManifest.rows_skipped_missing_pollutant_code = classification.rows_skipped_missing_pollutant_code;
  connectorManifest.example_missing_pollutant_rows = classification.example_missing_pollutant_rows;
  connectorManifest.pollutant_codes_written = classification.pollutant_codes_written;
  await publishOrStageHistoryObject({
    key: manifestKey,
    body: encodeJsonBody(connectorManifest),
    content_type: "application/json",
  });
  objectsWritten += 1;

  return {
    rows_read: rowsForWrite.length,
    objects_written_r2: INTEGRITY_PROPOSAL_MODE ? 0 : objectsWritten,
    objects_staged_local: INTEGRITY_PROPOSAL_MODE ? objectsWritten : 0,
    manifest_key: manifestKey,
    connector_manifest: connectorManifest as ObsConnectorManifest & Record<string, unknown>,
    rows_with_missing_pollutant_code: classification.rows_with_missing_pollutant_code,
    rows_skipped_missing_pollutant_code: classification.rows_skipped_missing_pollutant_code,
    example_missing_pollutant_rows: classification.example_missing_pollutant_rows,
    pollutant_codes_written: classification.pollutant_codes_written,
  };
}

function aqilevelRowsToParquetRows(
  rows: AqilevelsHistoryRow[],
  connectorId: number,
): AqilevelsHistoryParquetRow[] {
  return rows.map((row) => ({
    connector_id: connectorId,
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    pollutant_code: row.pollutant_code,
    timestamp_hour_utc: row.timestamp_hour_utc,
    daqi_input_value_ugm3: row.daqi_input_value_ugm3,
    daqi_input_averaging_code: row.daqi_input_averaging_code,
    daqi_index_level: row.daqi_index_level,
    daqi_source_observation_count: row.daqi_source_observation_count,
    daqi_required_observation_count: row.daqi_required_observation_count,
    daqi_calculation_status: row.daqi_calculation_status,
    daqi_missing_reason: row.daqi_missing_reason,
    eaqi_input_value_ugm3: row.eaqi_input_value_ugm3,
    eaqi_input_averaging_code: row.eaqi_input_averaging_code,
    eaqi_index_level: row.eaqi_index_level,
    eaqi_source_observation_count: row.eaqi_source_observation_count,
    eaqi_required_observation_count: row.eaqi_required_observation_count,
    eaqi_calculation_status: row.eaqi_calculation_status,
    eaqi_missing_reason: row.eaqi_missing_reason,
    hourly_sample_count: row.hourly_sample_count,
    algorithm_version: row.algorithm_version,
    computed_at_utc: row.computed_at_utc,
    hourly_mean_ugm3: row.hourly_mean_ugm3,
    rolling24h_mean_ugm3: row.rolling24h_mean_ugm3,
    no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
    pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
    pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
    pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
    pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
    daqi_no2_index_level: row.daqi_no2_index_level,
    daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level,
    daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level,
    eaqi_no2_index_level: row.eaqi_no2_index_level,
    eaqi_pm25_index_level: row.eaqi_pm25_index_level,
    eaqi_pm10_index_level: row.eaqi_pm10_index_level,
    updated_at: row.updated_at,
  }));
}

function groupAqilevelRowsByPollutant(
  rows: AqilevelsHistoryRow[],
): Map<"no2" | "pm25" | "pm10", AqilevelsHistoryRow[]> {
  const grouped = new Map<"no2" | "pm25" | "pm10", AqilevelsHistoryRow[]>();
  for (const row of rows) {
    if (!grouped.has(row.pollutant_code)) grouped.set(row.pollutant_code, []);
    grouped.get(row.pollutant_code)?.push(row);
  }
  return grouped;
}

async function exportAqiConnectorRowsToR2V2(args: {
  run_id: string;
  day_utc: string;
  connector_id: number;
  rows: AqilevelsHistoryRow[];
  force_replace?: boolean;
}): Promise<{
  rows_read: number;
  objects_written_r2: number;
  objects_staged_local?: number;
  parquet_files_written: number;
  manifest_key: string;
  connector_manifest: AqilevelsConnectorManifest & Record<string, unknown>;
}> {
  if ((args.force_replace ?? FORCE_REPLACE) && !INTEGRITY_PROPOSAL_MODE) {
    await deleteR2Prefix(
      buildHistoryV2ConnectorPrefix(
        AQI_R2_HISTORY_DATA_PREFIX_V2,
        args.day_utc,
        args.connector_id,
      ),
    );
    await deleteR2Prefix(
      buildHistoryV2ConnectorPrefix(
        AQI_R2_HISTORY_DEBUG_PREFIX_V2,
        args.day_utc,
        args.connector_id,
      ),
    );
  }

  const sortedRows = [...args.rows].sort((left, right) => {
    if (left.pollutant_code !== right.pollutant_code) {
      return left.pollutant_code.localeCompare(right.pollutant_code);
    }
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return 0;
  });
  const pollutantGroups = groupAqilevelRowsByPollutant(sortedRows);
  const dataPollutantManifests: Array<Record<string, unknown>> = [];
  const debugPollutantManifests: Array<Record<string, unknown>> = [];
  let objectsWritten = 0;
  let parquetFilesWritten = 0;

  for (const [pollutantCode, pollutantRows] of pollutantGroups.entries()) {
    for (const profile of ["data", "debug"] as const) {
      const basePrefix = profile === "data"
        ? AQI_R2_HISTORY_DATA_PREFIX_V2
        : AQI_R2_HISTORY_DEBUG_PREFIX_V2;
      const fileEntries: ObsHistoryFileEntry[] = [];
      const rowChunks = chunkRows(pollutantRows, AQI_R2_PART_MAX_ROWS);
      for (let partIndex = 0; partIndex < rowChunks.length; partIndex += 1) {
        const chunk = rowChunks[partIndex];
        if (!chunk.length) continue;
        const parquetRows = aqilevelRowsToParquetRows(chunk, args.connector_id);
        const partSummary = summarizeAqilevelsPartRows(parquetRows);
        const partKey = buildHistoryV2PartKey(
          basePrefix,
          args.day_utc,
          args.connector_id,
          pollutantCode,
          partIndex,
        );
        const parquetBuffer = profile === "data"
          ? rowsToAqiDataV2ParquetBuffer(parquetRows)
          : rowsToAqiDebugV2ParquetBuffer(parquetRows);
        const putResult = await publishOrStageHistoryObject({
          key: partKey,
          body: parquetBuffer,
          content_type: "application/vnd.apache.parquet",
        });
        fileEntries.push({
          key: partKey,
          row_count: chunk.length,
          bytes: Math.trunc(putResult.bytes),
          etag_or_hash: putResult.etag || sha256Hex(parquetBuffer),
          min_timeseries_id: partSummary.min_timeseries_id,
          max_timeseries_id: partSummary.max_timeseries_id,
          pollutant_codes: [pollutantCode],
          min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
          max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
          timeseries_row_counts: partSummary.timeseries_row_counts,
        });
        objectsWritten += 1;
        parquetFilesWritten += 1;
      }
      const manifestKey = buildHistoryV2PollutantManifestKey(
        basePrefix,
        args.day_utc,
        args.connector_id,
        pollutantCode,
      );
      const pollutantManifest = createAqiV2PollutantManifest({
        profile,
        dayUtc: args.day_utc,
        connectorId: args.connector_id,
        pollutantCode,
        runId: args.run_id,
        manifestKey,
        sourceRowCount: pollutantRows.length,
        fileEntries,
        writerGitSha: OBS_R2_WRITER_GIT_SHA,
        backedUpAtUtc: nowIso(),
      });
      await publishOrStageHistoryObject({
        key: manifestKey,
        body: encodeJsonBody(pollutantManifest),
        content_type: "application/json",
      });
      objectsWritten += 1;
      if (profile === "data") {
        dataPollutantManifests.push(pollutantManifest);
      } else {
        debugPollutantManifests.push(pollutantManifest);
      }
    }
  }

  const dataConnectorManifestKey = buildHistoryV2ConnectorManifestKey(
    AQI_R2_HISTORY_DATA_PREFIX_V2,
    args.day_utc,
    args.connector_id,
  );
  const debugConnectorManifestKey = buildHistoryV2ConnectorManifestKey(
    AQI_R2_HISTORY_DEBUG_PREFIX_V2,
    args.day_utc,
    args.connector_id,
  );
  const dataConnectorManifest = createAqiV2ConnectorManifest({
    profile: "data",
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey: dataConnectorManifestKey,
    pollutantManifests: dataPollutantManifests,
    writerGitSha: OBS_R2_WRITER_GIT_SHA,
    backedUpAtUtc: nowIso(),
  });
  const debugConnectorManifest = createAqiV2ConnectorManifest({
    profile: "debug",
    dayUtc: args.day_utc,
    connectorId: args.connector_id,
    runId: args.run_id,
    manifestKey: debugConnectorManifestKey,
    pollutantManifests: debugPollutantManifests,
    writerGitSha: OBS_R2_WRITER_GIT_SHA,
    backedUpAtUtc: nowIso(),
  });
  await publishOrStageHistoryObject({
    key: dataConnectorManifestKey,
    body: encodeJsonBody(dataConnectorManifest),
    content_type: "application/json",
  });
  await publishOrStageHistoryObject({
    key: debugConnectorManifestKey,
    body: encodeJsonBody(debugConnectorManifest),
    content_type: "application/json",
  });
  objectsWritten += 2;

  return {
    rows_read: sortedRows.length,
    objects_written_r2: INTEGRITY_PROPOSAL_MODE ? 0 : objectsWritten,
    objects_staged_local: INTEGRITY_PROPOSAL_MODE ? objectsWritten : 0,
    parquet_files_written: parquetFilesWritten,
    manifest_key: dataConnectorManifestKey,
    connector_manifest: dataConnectorManifest as AqilevelsConnectorManifest & Record<string, unknown>,
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
  objects_staged_local?: number;
  parquet_files_written: number;
  manifest_key: string;
  connector_manifest: AqilevelsConnectorManifest & Record<string, unknown>;
}> {
  if (HISTORY_R2_WRITE_VERSION === "v2") {
    return await exportAqiConnectorRowsToR2V2(args);
  }

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

  const rowChunks = chunkRows(sortedRows, AQI_R2_PART_MAX_ROWS);
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
      daqi_input_value_ugm3: row.daqi_input_value_ugm3,
      daqi_input_averaging_code: row.daqi_input_averaging_code,
      daqi_index_level: row.daqi_index_level,
      daqi_source_observation_count: row.daqi_source_observation_count,
      daqi_required_observation_count: row.daqi_required_observation_count,
      daqi_calculation_status: row.daqi_calculation_status,
      daqi_missing_reason: row.daqi_missing_reason,
      eaqi_input_value_ugm3: row.eaqi_input_value_ugm3,
      eaqi_input_averaging_code: row.eaqi_input_averaging_code,
      eaqi_index_level: row.eaqi_index_level,
      eaqi_source_observation_count: row.eaqi_source_observation_count,
      eaqi_required_observation_count: row.eaqi_required_observation_count,
      eaqi_calculation_status: row.eaqi_calculation_status,
      eaqi_missing_reason: row.eaqi_missing_reason,
      hourly_sample_count: row.hourly_sample_count,
      algorithm_version: row.algorithm_version,
      computed_at_utc: row.computed_at_utc,
      hourly_mean_ugm3: row.hourly_mean_ugm3,
      rolling24h_mean_ugm3: row.rolling24h_mean_ugm3,
      no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3,
      pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3,
      pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3,
      pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3,
      pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3,
      daqi_no2_index_level: row.daqi_no2_index_level,
      daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level,
      daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level,
      eaqi_no2_index_level: row.eaqi_no2_index_level,
      eaqi_pm25_index_level: row.eaqi_pm25_index_level,
      eaqi_pm10_index_level: row.eaqi_pm10_index_level,
      updated_at: row.updated_at,
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
      pollutant_codes: partSummary.pollutant_codes,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
      timeseries_row_counts: partSummary.timeseries_row_counts,
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
  return await loadAllAqiConnectorManifestsForDayPrefix(
    dayUtc,
    activeAqiHistoryDataPrefix(),
  );
}

async function loadAllAqiConnectorManifestsForDayPrefix(
  dayUtc: string,
  basePrefix: string,
): Promise<Array<AqilevelsConnectorManifest & Record<string, unknown>>> {
  const prefix = `${basePrefix}/day_utc=${dayUtc}/connector_id=`;
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
    const manifest = await loadAqiConnectorManifestByKey(
      dayUtc,
      Math.trunc(connectorId),
      `${basePrefix}/day_utc=${dayUtc}/connector_id=${Math.trunc(connectorId)}/manifest.json`,
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

function toSafeWholeNumber(value: unknown): number | null {
  const parsed = toSafeNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.max(0, Math.trunc(parsed));
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text : null;
}

function optionalIsoTimestamp(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  const timestampMs = Date.parse(text);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function daqiAveragingCodeForPollutant(
  pollutantCode: "no2" | "pm25" | "pm10",
): "hourly_mean" | "rolling_24h_mean" {
  return pollutantCode === "no2" ? "hourly_mean" : "rolling_24h_mean";
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
  { day_utc: string; manifest_key: string; source: "dropbox" | "r2" } | null
> {
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  for (let offset = 0; offset <= R2_CORE_LOOKBACK_DAYS; offset += 1) {
    const dayUtc = shiftIsoDay(todayUtc, -offset);
    const manifestKey = buildCoreDayManifestKey(dayUtc);
    const localPath = resolveLocalHistoryPathForR2Key(manifestKey);
    if (localPath && fs.existsSync(localPath)) {
      return {
        day_utc: dayUtc,
        manifest_key: manifestKey,
        source: "dropbox",
      };
    }
    if (!hasRequiredR2Config(OBS_R2_CONFIG)) {
      continue;
    }
    const head = await r2HeadObject({ r2: OBS_R2_CONFIG, key: manifestKey });
    if (head.exists) {
      return {
        day_utc: dayUtc,
        manifest_key: manifestKey,
        source: "r2",
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

async function loadR2CoreObservedPropertyMappings(): Promise<ObservedPropertyMapping[]> {
  if (r2CoreObservedPropertyMappingsPromise) {
    return await r2CoreObservedPropertyMappingsPromise;
  }
  r2CoreObservedPropertyMappingsPromise = (async () => {
    const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
    if (!snapshotInfo) throw new Error("core_snapshot_manifest_missing");
    const manifestObject = await loadHistoryObjectBytesByR2Key(snapshotInfo.manifest_key);
    const manifest = parseCoreSnapshotManifest(
      new TextDecoder().decode(manifestObject.body),
      snapshotInfo.manifest_key,
    );
    const tableKey = findCoreTableKey(manifest, "observed_property_mappings");
    if (!tableKey) throw new Error("core_snapshot_missing_observed_property_mappings");
    const object = await loadHistoryObjectBytesByR2Key(tableKey);
    const rows = parseCoreTableRows(decodeCoreTableText(object.body, tableKey));
    const mappings = rows.map((row): ObservedPropertyMapping => ({
      connector_id: Number(row.connector_id),
      source_label: String(row.source_label || ""),
      source_uom: row.source_uom == null ? null : String(row.source_uom),
      observed_property_id: row.observed_property_id == null ? null : Number(row.observed_property_id),
      observed_property_code: row.observed_property_code == null ? null : String(row.observed_property_code),
      mapping_kind: String(row.mapping_kind || "unknown") as ObservedPropertyMapping["mapping_kind"],
      is_aqi_eligible: row.is_aqi_eligible === true,
      is_active: row.is_active === true,
    })).filter((row) => Number.isInteger(row.connector_id) && row.source_label.trim());
    if (!mappings.length) throw new Error("core_snapshot_observed_property_mappings_empty");
    logStructured("info", "backfill_core_observed_property_mappings_loaded", {
      snapshot_day_utc: manifest.day_utc || snapshotInfo.day_utc,
      row_count: mappings.length,
    });
    return mappings;
  })();
  return await r2CoreObservedPropertyMappingsPromise;
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
  const ambiguousStationPollutantKeys = new Set<string>();
  const ambiguousTimeseriesRefKeys = new Set<string>();
  const ambiguousTimeseriesRefPollutantKeys = new Set<string>();

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
    if (existingByStation && existingByStation.timeseries_id !== binding.timeseries_id) {
      ambiguousStationPollutantKeys.add(stationKey);
    }
    if (
      !existingByStation ||
      binding.timeseries_id < existingByStation.timeseries_id
    ) {
      bindingByStationPollutant.set(stationKey, binding);
    }
    const existingById = bindingByTimeseriesId.get(binding.timeseries_id);
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY && existingById &&
      (existingById.station_id !== binding.station_id ||
        existingById.pollutant_code !== binding.pollutant_code ||
        existingById.timeseries_ref !== binding.timeseries_ref)) {
      throw new Error(`ambiguous_timeseries_id connector_id=${connectorId} timeseries_id=${binding.timeseries_id}`);
    }
    if (!existingById || binding.station_id < existingById.station_id) {
      bindingByTimeseriesId.set(binding.timeseries_id, binding);
    }

    const existingByTimeseries = bindingByTimeseriesRef.get(
      binding.timeseries_ref,
    );
    if (existingByTimeseries && existingByTimeseries.timeseries_id !== binding.timeseries_id) {
      ambiguousTimeseriesRefKeys.add(binding.timeseries_ref);
    }
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
    if (existingBySensorPollutant && existingBySensorPollutant.timeseries_id !== binding.timeseries_id) {
      ambiguousTimeseriesRefPollutantKeys.add(sensorPollutantKey);
    }
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
    ambiguous_station_pollutant_keys: ambiguousStationPollutantKeys,
    ambiguous_timeseries_ref_keys: ambiguousTimeseriesRefKeys,
    ambiguous_timeseries_ref_pollutant_keys: ambiguousTimeseriesRefPollutantKeys,
  };
}

async function loadR2CoreStationIdsByConnector(): Promise<
  Map<number, number[]> | null
> {
  if (!SHOULD_USE_R2_CORE_METADATA) {
    return null;
  }
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
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
          local_dropbox_root: R2_HISTORY_DROPBOX_ROOT,
        });
        return null;
      }

      const manifestObject = await loadHistoryObjectBytesByR2Key(
        snapshotInfo.manifest_key,
      );
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

      const timeseriesObject = await loadHistoryObjectBytesByR2Key(
        timeseriesTableKey,
      );
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
        snapshot_source: snapshotInfo.source,
        object_source: manifestObject.source,
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
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
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

      const manifestObject = await loadHistoryObjectBytesByR2Key(
        snapshotInfo.manifest_key,
      );
      const manifestText = new TextDecoder().decode(manifestObject.body);
      const manifest = parseCoreSnapshotManifest(
        manifestText,
        snapshotInfo.manifest_key,
      );
      const stationsTableKey = findCoreTableKey(manifest, "stations");
      if (!stationsTableKey) {
        return null;
      }

      const stationsObject = await loadHistoryObjectBytesByR2Key(
        stationsTableKey,
      );
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
    appendRowsSafe(rows, pageRows);
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
      logStructured("warning", "backfill_station_refs_r2_core_fallback", {
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
    logStructured("warning", "backfill_station_ids_r2_core_fallback", {
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
  if (/^[a-z0-9_]+$/.test(normalized)) return normalized;
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
  const ambiguousStationPollutantKeys = new Set<string>();
  const ambiguousTimeseriesRefKeys = new Set<string>();
  const ambiguousTimeseriesRefPollutantKeys = new Set<string>();

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
    if (existing && existing.timeseries_id !== binding.timeseries_id) {
      ambiguousStationPollutantKeys.add(key);
    }
    if (!existing || binding.timeseries_id < existing.timeseries_id) {
      bindingByStationPollutant.set(key, binding);
    }
    const existingById = bindingByTimeseriesId.get(binding.timeseries_id);
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY && existingById &&
      (existingById.station_id !== binding.station_id ||
        existingById.pollutant_code !== binding.pollutant_code ||
        existingById.timeseries_ref !== binding.timeseries_ref)) {
      throw new Error(`ambiguous_timeseries_id connector_id=${connectorId} timeseries_id=${binding.timeseries_id}`);
    }
    if (!existingById || binding.station_id < existingById.station_id) {
      bindingByTimeseriesId.set(binding.timeseries_id, binding);
    }
    const existingByRef = bindingByTimeseriesRef.get(binding.timeseries_ref);
    if (existingByRef && existingByRef.timeseries_id !== binding.timeseries_id) {
      ambiguousTimeseriesRefKeys.add(binding.timeseries_ref);
    }
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
    if (existingByRefPollutant && existingByRefPollutant.timeseries_id !== binding.timeseries_id) {
      ambiguousTimeseriesRefPollutantKeys.add(sensorPollutantKey);
    }
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
    ambiguous_station_pollutant_keys: ambiguousStationPollutantKeys,
    ambiguous_timeseries_ref_keys: ambiguousTimeseriesRefKeys,
    ambiguous_timeseries_ref_pollutant_keys: ambiguousTimeseriesRefPollutantKeys,
  };
}

async function loadR2CoreSourceLookupForConnector(
  connectorId: number,
): Promise<SourceConnectorLookup | null> {
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
  if (!snapshotInfo) {
    return null;
  }
  const manifestObject = await loadHistoryObjectBytesByR2Key(
    snapshotInfo.manifest_key,
  );
  const manifest = parseCoreSnapshotManifest(
    new TextDecoder().decode(manifestObject.body),
    snapshotInfo.manifest_key,
  );
  const timeseriesTableKey = findCoreTableKey(manifest, "timeseries");
  if (!timeseriesTableKey) {
    return null;
  }

  const timeseriesObject = await loadHistoryObjectBytesByR2Key(
    timeseriesTableKey,
  );
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
    appendRowsSafe(rows, pageRows);

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
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
    return null;
  }

  const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
  if (!snapshotInfo) {
    return null;
  }
  const manifestObject = await loadHistoryObjectBytesByR2Key(
    snapshotInfo.manifest_key,
  );
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
    loadHistoryObjectBytesByR2Key(stationsTableKey),
    loadHistoryObjectBytesByR2Key(timeseriesTableKey),
    loadHistoryObjectBytesByR2Key(phenomenaTableKey),
    loadHistoryObjectBytesByR2Key(observedPropertiesTableKey),
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

async function fetchSosSourceLookupForConnector(
  connectorId: number,
  candidateStationRefs: Set<string>,
): Promise<SourceConnectorLookup> {
  return await fetchMetadataSourceLookupForConnector(
    connectorId,
    candidateStationRefs,
    "sos",
  );
}

function isSosMappingValidForDay(
  mapping: SosSiteTimeseriesRef,
  dayUtc: string,
): boolean {
  if (mapping.valid_from_day_utc && mapping.valid_from_day_utc > dayUtc) {
    return false;
  }
  if (mapping.valid_to_day_utc && mapping.valid_to_day_utc < dayUtc) {
    return false;
  }
  return true;
}

async function fetchSosSiteTimeseriesRefsForConnector(
  connectorId: number,
  candidateTimeseriesIds: number[],
): Promise<SosSiteTimeseriesRef[]> {
  if (!(INGEST_SUPABASE_URL && INGEST_PRIVILEGED_KEY)) {
    throw new Error(
      "UK-AIR flat-file mapping guard requires SUPABASE_URL and SB_SECRET_KEY",
    );
  }
  if (connectorId !== SOS_CONNECTOR_ID_FALLBACK) {
    logStructured("warning", "sos_mapping_guard_connector_id_assumption", {
      connector_id: connectorId,
      fallback_connector_id: SOS_CONNECTOR_ID_FALLBACK,
    });
  }
  if (!candidateTimeseriesIds.length && !INTEGRITY_COMPLETE_CONNECTOR_DAY) {
    return [];
  }

  const rows: SosSiteTimeseriesRef[] = [];
  const idChunks = INTEGRITY_COMPLETE_CONNECTOR_DAY
    ? [null]
    : chunkRows(candidateTimeseriesIds, STATION_ID_PAGE_SIZE);
  for (const idChunk of idChunks) {
    const query = new URLSearchParams();
    query.set(
      "select",
      "site_ref,uk_air_ref,pollutant_code,station_id,timeseries_id,station_ref,timeseries_ref,valid_from_day_utc,valid_to_day_utc",
    );
    if (idChunk) query.set("timeseries_id", `in.(${idChunk.join(",")})`);
    query.set("order", "site_ref.asc,pollutant_code.asc,timeseries_id.asc");
    const rawRows = await fetchAllRowsPaged({
      baseUrl: INGEST_SUPABASE_URL,
      privilegedKey: INGEST_PRIVILEGED_KEY,
      schema: "uk_aq_raw",
      table: "sos_station_timeseries_site_refs",
      query,
      label: `UK-AIR flat-file mapping query failed for connector_id=${connectorId}`,
    });

    for (const raw of rawRows) {
      const siteRef = String(raw.site_ref || "").trim();
      const pollutantCode = parseSourcePollutantCode(String(raw.pollutant_code || ""));
      const stationId = Number(raw.station_id);
      const timeseriesId = Number(raw.timeseries_id);
      if (
        !siteRef || !pollutantCode ||
        !Number.isInteger(stationId) || stationId <= 0 ||
        !Number.isInteger(timeseriesId) || timeseriesId <= 0
      ) {
        if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
          throw new Error(
            `invalid_sos_mapping_row connector_id=${connectorId} row=${JSON.stringify(raw)}`,
          );
        }
        continue;
      }
      rows.push({
        site_ref: siteRef,
        uk_air_ref: raw.uk_air_ref == null ? null : String(raw.uk_air_ref),
        pollutant_code: pollutantCode,
        station_id: Math.trunc(stationId),
        timeseries_id: Math.trunc(timeseriesId),
        station_ref: raw.station_ref == null ? null : String(raw.station_ref),
        timeseries_ref: raw.timeseries_ref == null ? null : String(raw.timeseries_ref),
        valid_from_day_utc: parseOptionalDay(raw.valid_from_day_utc),
        valid_to_day_utc: parseOptionalDay(raw.valid_to_day_utc),
      });
    }
  }
  return rows;
}

async function assertSosFlatFileMappingsForBackfill(args: {
  connector_id: number;
  day_utc: string;
  bindings: SourceTimeseriesBinding[];
}): Promise<SosSiteTimeseriesRef[]> {
  const candidateIds = sortedUniquePositiveInts(
    args.bindings.map((binding) => binding.timeseries_id),
  );
  const mappingRows = await fetchSosSiteTimeseriesRefsForConnector(
    args.connector_id,
    candidateIds,
  );
  const scopedMappingRows = INTEGRITY_POLLUTANT_SCOPED_REPAIR
    ? mappingRows.filter((row) =>
      INTEGRITY_REPAIR_POLLUTANTS.has(row.pollutant_code)
    )
    : mappingRows;
  const validRows = scopedMappingRows.filter((row) =>
    isSosMappingValidForDay(row, args.day_utc)
  );
  const candidateIdSet = new Set(candidateIds);
  const candidateMappingRows = validRows.filter((row) =>
    candidateIdSet.has(row.timeseries_id)
  );
  const mappingsOutsideCandidateScope = validRows.filter((row) =>
    !candidateIdSet.has(row.timeseries_id)
  );
  const validByTimeseriesId = new Map<number, SosSiteTimeseriesRef[]>();
  const validBySitePollutant = new Map<string, SosSiteTimeseriesRef[]>();

  for (const row of candidateMappingRows) {
    const byId = validByTimeseriesId.get(row.timeseries_id) || [];
    byId.push(row);
    validByTimeseriesId.set(row.timeseries_id, byId);

    const sitePollutant = stationPollutantKey(row.site_ref, row.pollutant_code);
    const bySitePollutant = validBySitePollutant.get(sitePollutant) || [];
    bySitePollutant.push(row);
    validBySitePollutant.set(sitePollutant, bySitePollutant);
  }

  const missing = candidateIds.filter((timeseriesId) =>
    !(validByTimeseriesId.get(timeseriesId) || []).length
  );
  const ambiguousByTimeseries = Array.from(validByTimeseriesId.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([timeseriesId, rows]) => ({
      timeseries_id: timeseriesId,
      mappings: rows.map((row) => ({
        site_ref: row.site_ref,
        pollutant_code: row.pollutant_code,
        station_id: row.station_id,
        timeseries_id: row.timeseries_id,
      })),
    }));
  const ambiguousBySitePollutant = Array.from(validBySitePollutant.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.timeseries_id)).size > 1)
    .map(([key, rows]) => ({
      site_pollutant_key: key,
      mappings: rows.map((row) => ({
        site_ref: row.site_ref,
        pollutant_code: row.pollutant_code,
        station_id: row.station_id,
        timeseries_id: row.timeseries_id,
      })),
    }));

  if (
    (!INTEGRITY_COMPLETE_CONNECTOR_DAY && missing.length) ||
    mappingsOutsideCandidateScope.length ||
    ambiguousByTimeseries.length ||
    ambiguousBySitePollutant.length
  ) {
    const details = {
      day_utc: args.day_utc,
      connector_id: args.connector_id,
      candidate_timeseries_count: candidateIds.length,
      mapping_rows: mappingRows.length,
      scoped_mapping_rows: scopedMappingRows.length,
      valid_mapping_rows: validRows.length,
      candidate_mapping_rows: candidateMappingRows.length,
      unmapped_candidate_timeseries_count: missing.length,
      missing_timeseries_ids: missing.slice(0, 50),
      mapping_timeseries_outside_candidate_scope:
        mappingsOutsideCandidateScope.slice(0, 50).map((row) => row.timeseries_id),
      ambiguous_timeseries_sample: ambiguousByTimeseries.slice(0, 10),
      ambiguous_site_pollutant_sample: ambiguousBySitePollutant.slice(0, 10),
    };
    logStructured("error", "sos_flat_file_mapping_guard_failed", details);
    throw new Error(
      `UK-AIR flat-file mapping guard failed for day_utc=${args.day_utc} connector_id=${args.connector_id}: ` +
      `missing_timeseries=${missing.length} ambiguous_timeseries=${ambiguousByTimeseries.length} ` +
        `ambiguous_site_ref_pollutant=${ambiguousBySitePollutant.length} ` +
        `mapping_timeseries_outside_candidate_scope=${mappingsOutsideCandidateScope.length}`,
    );
  }

  logStructured("info", "sos_flat_file_mapping_guard_ok", {
    day_utc: args.day_utc,
    connector_id: args.connector_id,
    candidate_timeseries_count: candidateIds.length,
    scoped_mapping_rows: scopedMappingRows.length,
    valid_mapping_rows: validRows.length,
    candidate_mapping_rows: candidateMappingRows.length,
    unmapped_candidate_timeseries_count: missing.length,
    site_ref_count: new Set(candidateMappingRows.map((row) => row.site_ref)).size,
  });
  return candidateMappingRows;
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
      logStructured(
        shouldTryR2Core ? "warning" : "info",
        "source_lookup_resolved",
        {
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
    ambiguous_station_pollutant_keys: new Set<string>(),
    ambiguous_timeseries_ref_keys: new Set<string>(),
    ambiguous_timeseries_ref_pollutant_keys: new Set<string>(),
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

  const emptyCandidateStationRefs = new Set<string>();
  const shouldTryR2Core = SHOULD_USE_R2_CORE_METADATA;
  if (shouldTryR2Core) {
    try {
      const fromR2Metadata = await loadR2CoreOpenaqSourceLookupForConnector(
        connectorId,
        emptyCandidateStationRefs,
        "local_to_aqilevels",
      );
      if (
        fromR2Metadata &&
        fromR2Metadata.binding_by_station_pollutant.size > 0
      ) {
        sourceLookupCache.set(connectorId, fromR2Metadata);
        logStructured("info", "source_lookup_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core_metadata",
          station_ref_count: fromR2Metadata.station_refs.size,
          timeseries_binding_count:
            fromR2Metadata.binding_by_station_pollutant.size,
        });
        return fromR2Metadata;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("warning", "source_lookup_r2_core_metadata_failed", {
        connector_id: connectorId,
        error: message,
      });
    }

    try {
      const fromR2Legacy = await loadR2CoreSourceLookupForConnector(connectorId);
      if (fromR2Legacy && fromR2Legacy.binding_by_station_pollutant.size > 0) {
        sourceLookupCache.set(connectorId, fromR2Legacy);
        logStructured("info", "source_lookup_resolved", {
          connector_id: connectorId,
          metadata_source: "r2_core_legacy_ref",
          station_ref_count: fromR2Legacy.station_refs.size,
          timeseries_binding_count:
            fromR2Legacy.binding_by_station_pollutant.size,
        });
        return fromR2Legacy;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStructured("warning", "source_lookup_r2_core_legacy_failed", {
        connector_id: connectorId,
        error: message,
      });
    }
  }

  try {
    const fromIngestMetadata = await loadIngestOpenaqSourceLookupForConnector(
      connectorId,
      emptyCandidateStationRefs,
      "local_to_aqilevels",
    );
    if (
      fromIngestMetadata &&
      fromIngestMetadata.binding_by_station_pollutant.size > 0
    ) {
      sourceLookupCache.set(connectorId, fromIngestMetadata);
      logStructured(
        shouldTryR2Core ? "warning" : "info",
        "source_lookup_resolved",
        {
        connector_id: connectorId,
        metadata_source: "ingestdb_metadata",
        station_ref_count: fromIngestMetadata.station_refs.size,
        timeseries_binding_count:
          fromIngestMetadata.binding_by_station_pollutant.size,
      });
      return fromIngestMetadata;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("warning", "source_lookup_ingest_metadata_failed", {
      connector_id: connectorId,
      error: message,
    });
  }

  try {
    const fromIngestLegacy = await loadIngestSourceLookupForConnector(
      connectorId,
    );
    if (
      fromIngestLegacy &&
      fromIngestLegacy.binding_by_station_pollutant.size > 0
    ) {
      sourceLookupCache.set(connectorId, fromIngestLegacy);
      logStructured(
        shouldTryR2Core ? "warning" : "info",
        "source_lookup_resolved",
        {
        connector_id: connectorId,
        metadata_source: "ingestdb_legacy_ref",
        station_ref_count: fromIngestLegacy.station_refs.size,
        timeseries_binding_count:
          fromIngestLegacy.binding_by_station_pollutant.size,
      });
      return fromIngestLegacy;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStructured("warning", "source_lookup_ingest_legacy_failed", {
      connector_id: connectorId,
      error: message,
    });
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

  if (R2_HISTORY_DROPBOX_ROOT || hasRequiredR2Config(OBS_R2_CONFIG)) {
    try {
      const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
      if (snapshotInfo) {
        const manifestObject = await loadHistoryObjectBytesByR2Key(
          snapshotInfo.manifest_key,
        );
        const manifest = parseCoreSnapshotManifest(
          new TextDecoder().decode(manifestObject.body),
          snapshotInfo.manifest_key,
        );
        const connectorsTableKey = findCoreTableKey(manifest, "connectors");
        if (connectorsTableKey) {
          const connectorsObject = await loadHistoryObjectBytesByR2Key(
            connectorsTableKey,
          );
          const ndjsonText = decodeCoreTableText(
            connectorsObject.body,
            connectorsTableKey,
          );
          for (const line of ndjsonText.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const row = JSON.parse(trimmed) as Record<string, unknown>;
              const rowCode = String(row.connector_code || "").trim()
                .toLowerCase();
              const rowId = Number(row.id);
              if (
                rowCode === connectorCode && Number.isInteger(rowId) &&
                rowId > 0
              ) {
                connectorCodeCache.set(connectorCode, Math.trunc(rowId));
                return Math.trunc(rowId);
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch {
      // Fall through to Supabase fallback below.
    }
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

  return null;
}

async function resolveConnectorServiceUrl(
  connectorId: number,
): Promise<string | null> {
  const cached = connectorServiceUrlCache.get(connectorId);
  if (cached !== undefined) {
    return cached;
  }

  if (R2_HISTORY_DROPBOX_ROOT || hasRequiredR2Config(OBS_R2_CONFIG)) {
    try {
      const snapshotInfo = await findLatestCoreSnapshotManifestInfo();
      if (snapshotInfo) {
        const manifestObject = await loadHistoryObjectBytesByR2Key(
          snapshotInfo.manifest_key,
        );
        const manifest = parseCoreSnapshotManifest(
          new TextDecoder().decode(manifestObject.body),
          snapshotInfo.manifest_key,
        );
        const connectorsTableKey = findCoreTableKey(manifest, "connectors");
        if (connectorsTableKey) {
          const connectorsObject = await loadHistoryObjectBytesByR2Key(
            connectorsTableKey,
          );
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
        }
      }
    } catch {
      // Fall through to Supabase fallback below.
    }
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

function sosMirrorFilePath(
  dayUtc: string,
  timeseriesRef: string,
): string | null {
  if (!IS_LOCAL_RUN || !SOS_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = SOS_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(
    root,
    `day_utc=${normalizedDay}`,
    `${encodeURIComponent(timeseriesRef)}.json`,
  );
}

const sosIntegritySnapshotCache = new Map<
  string,
  Map<string, Array<Record<string, unknown>>> | null
>();

function sosIntegritySnapshotFilePath(
  dayUtc: string,
  stationRef: string,
): string | null {
  if (!IS_LOCAL_RUN) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = (SOS_INTEGRITY_SNAPSHOT_ROOT || "").trim();
  if (!root) {
    return null;
  }
  const stationToken = encodeURIComponent(stationRef);
  return path.join(
    root,
    `station_ref=${stationToken}`,
    `day_utc=${normalizedDay}`,
    "snapshot.ndjson",
  );
}

function readSosIntegritySnapshotTimeseriesPayload(args: {
  day_utc: string;
  station_ref: string;
  timeseries_ref: string;
}): unknown | null {
  const snapshotPath = sosIntegritySnapshotFilePath(
    args.day_utc,
    args.station_ref,
  );
  if (!snapshotPath) {
    return null;
  }
  if (!sosIntegritySnapshotCache.has(snapshotPath)) {
    if (!fs.existsSync(snapshotPath)) {
      sosIntegritySnapshotCache.set(snapshotPath, null);
    } else if (fs.statSync(snapshotPath).size <= 0) {
      sosIntegritySnapshotCache.set(snapshotPath, null);
    } else {
      const byTimeseriesRef = new Map<string, Array<Record<string, unknown>>>();
      const text = fs.readFileSync(snapshotPath, "utf8");
      const lines = text.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Failed to parse UK-AIR SOS integrity snapshot ${snapshotPath}: ${message}`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        const row = parsed as Record<string, unknown>;
        const timeseriesRef = String(row.timeseries_ref || "").trim();
        const observedAt = String(row.observed_at_utc || "").trim();
        const value = toFiniteNumber(row.value);
        const status = row.status == null ? null : String(row.status);
        if (!timeseriesRef || !observedAt || value === null) {
          continue;
        }
        const values = byTimeseriesRef.get(timeseriesRef) || [];
        values.push({ time: observedAt, value, status });
        byTimeseriesRef.set(timeseriesRef, values);
      }
      sosIntegritySnapshotCache.set(snapshotPath, byTimeseriesRef);
    }
  }

  const byTimeseriesRef = sosIntegritySnapshotCache.get(snapshotPath) || null;
  if (!byTimeseriesRef) {
    return null;
  }
  const values = byTimeseriesRef.get(args.timeseries_ref) || [];
  return { values };
}

function sosNoDataManifestFilePath(dayUtc: string): string | null {
  if (!IS_LOCAL_RUN || !SOS_RAW_MIRROR_ROOT) {
    return null;
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return null;
  }
  const root = SOS_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  return path.join(root, `day_utc=${normalizedDay}`, "_no_data_timeseries.json");
}

function isSosEmptyPayload(payload: unknown): boolean {
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

function readSosNoDataManifest(
  dayUtc: string,
): Map<string, SosNoDataManifestEntry> {
  const manifestPath = sosNoDataManifestFilePath(dayUtc);
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
  const entries = new Map<string, SosNoDataManifestEntry>();
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

function writeSosNoDataManifest(args: {
  day_utc: string;
  entries: Map<string, SosNoDataManifestEntry>;
}): void {
  const manifestPath = sosNoDataManifestFilePath(args.day_utc);
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

async function fetchSosTimeseriesData(args: {
  base_url: string;
  day_utc: string;
  station_ref: string;
  timeseries_ref: string;
  timespan: string;
  known_empty_timeseries_refs?: ReadonlySet<string>;
}): Promise<SosTimeseriesFetchResult> {
  const mirrorPath = sosMirrorFilePath(
    args.day_utc,
    args.timeseries_ref,
  );
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    try {
      return {
        payload: JSON.parse(fs.readFileSync(mirrorPath, "utf8")) as unknown,
        mirror_reused: true,
        mirror_written: false,
        integrity_snapshot_reused: false,
        no_data_manifest_reused: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to parse UK-AIR SOS mirror ${mirrorPath}: ${message}`,
      );
    }
  }

  const integritySnapshotPayload = readSosIntegritySnapshotTimeseriesPayload({
    day_utc: args.day_utc,
    station_ref: args.station_ref,
    timeseries_ref: args.timeseries_ref,
  });
  if (integritySnapshotPayload) {
    return {
      payload: integritySnapshotPayload,
      mirror_reused: false,
      mirror_written: false,
      integrity_snapshot_reused: true,
      no_data_manifest_reused: false,
    };
  }

  if (args.known_empty_timeseries_refs?.has(args.timeseries_ref)) {
    return {
      payload: { values: [] },
      mirror_reused: false,
      mirror_written: false,
      integrity_snapshot_reused: false,
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
    SOS_TIMEOUT_MS,
    SOS_FETCH_RETRIES,
    SOS_RETRY_BASE_MS,
  );
  const shouldWriteMirror = mirrorPath && shouldWriteSosMirrorPayload(payload);
  if (shouldWriteMirror) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, JSON.stringify(payload), "utf8");
  }
  return {
    payload,
    mirror_reused: false,
    mirror_written: Boolean(shouldWriteMirror),
    integrity_snapshot_reused: false,
    no_data_manifest_reused: false,
  };
}

function shouldWriteSosMirrorPayload(payload: unknown): boolean {
  return !isSosEmptyPayload(payload);
}

function parseSosTimestamp(value: unknown): string | null {
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

function parseSosDatapoints(values: unknown): SosDatapoint[] {
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

  const datapoints: SosDatapoint[] = [];
  for (const row of rows) {
    let observedAtIso: string | null = null;
    let value: number | null = null;
    let status: string | null = null;

    if (Array.isArray(row)) {
      if (row.length < 2) {
        continue;
      }
      observedAtIso = parseSosTimestamp(row[0]);
      value = toFiniteNumber(row[1]);
      status = row.length > 2 && row[2] != null ? String(row[2]) : null;
    } else if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      observedAtIso = parseSosTimestamp(
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

async function processSosTimeseriesBatch(args: {
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
}): Promise<SosTimeseriesProcessResult[]> {
  return await mapConcurrent(
    args.bindings,
    args.concurrency,
    async (binding): Promise<SosTimeseriesProcessResult> => {
      try {
        const payload = await fetchSosTimeseriesData({
          base_url: args.base_url,
          day_utc: args.day_utc,
          station_ref: binding.station_ref,
          timeseries_ref: binding.timeseries_ref,
          timespan: args.timespan,
          known_empty_timeseries_refs: args.known_empty_timeseries_refs,
        });
        const datapoints = parseSosDatapoints(payload.payload);
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
            status: datapoint.status,
          });
        }

        const emptyPayloadConfirmed = isSosEmptyPayload(payload.payload);
        logStructured(
          "info",
          "source_to_r2_sos_timeseries_processed",
          {
            run_id: args.run_id,
            day_utc: args.day_utc,
            connector_id: args.connector_id,
            source_adapter: "sos",
            station_ref: binding.station_ref,
            timeseries_ref: binding.timeseries_ref,
            timeseries_id: binding.timeseries_id,
            pollutant_code: binding.pollutant_code,
            raw_point_count: datapoints.length,
            mapped_point_count: rows.length,
            status_values: Array.from(
              new Set(rows.map((row) => row.status).filter((value) => value)),
            ).sort(),
            mirror_reused: payload.mirror_reused,
            mirror_written: payload.mirror_written,
            integrity_snapshot_reused: payload.integrity_snapshot_reused,
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
          integrity_snapshot_reused: payload.integrity_snapshot_reused,
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
          "source_to_r2_sos_timeseries_failed",
          {
            run_id: args.run_id,
            day_utc: args.day_utc,
            connector_id: args.connector_id,
            source_adapter: "sos",
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
          integrity_snapshot_reused: false,
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

type SensorcommunityArchiveIndexResult = {
  file_names: string[];
  day_missing: boolean;
  index_url: string;
};

function parseHttpStatusFromErrorMessage(message: string): number | null {
  const match = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    return null;
  }
  return parsed;
}

async function fetchSensorcommunityArchiveFileNames(
  dayUtc: string,
): Promise<SensorcommunityArchiveIndexResult> {
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
    const httpStatus = parseHttpStatusFromErrorMessage(message);
    if (httpStatus === 404) {
      return {
        file_names: [],
        day_missing: true,
        index_url: indexUrl,
      };
    }
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
  if (files.size === 0) {
    throw new Error(
      "sensorcommunity_archive_index_fetch_failed: " +
        `unrecognised_http_200_index_response day_utc=${dayUtc} index_url=${indexUrl}`,
    );
  }
  return {
    file_names: Array.from(files).sort((left, right) =>
      left.localeCompare(right)
    ),
    day_missing: false,
    index_url: indexUrl,
  };
}

function sourceMirrorFilePath(dayUtc: string, fileName: string): string | null {
  if (!SCOMM_RAW_MIRROR_ROOT) {
    return null;
  }
  const root = SCOMM_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return null;
  }
  const candidates = [
    path.join(root, `day_utc=${dayUtc}`, fileName),
    // Integrity acquisition stores Sensor.Community files under the plain
    // UTC day directory. Keep the v2-shaped path first for established
    // backfill mirrors, but never require an archive fetch when this cache
    // already contains the authoritative file.
    path.join(root, dayUtc, fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

async function fetchSensorcommunityArchiveCsv(
  dayUtc: string,
  fileName: string,
): Promise<string> {
  const mirrorPath = sourceMirrorFilePath(dayUtc, fileName);
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    return fs.readFileSync(mirrorPath, "utf8");
  }
  if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
    throw new Error(
      `sensorcommunity_complete_connector_day_cache_missing: ${fileName}`,
    );
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
}): {
  rows: SourceObservationRow[];
  source_records: number;
  skipped_outside_day: number;
  skipped_null_value: number;
} {
  const { dayUtc, csvText, lookup } = args;
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return { rows: [], source_records: 0, skipped_outside_day: 0, skipped_null_value: 0 };
  }

  const headers = lines[0].split(";").map((header) => header.trim());
  const headerIndex = new Map<string, number>();
  headers.forEach((header, index) => {
    headerIndex.set(header.toLowerCase(), index);
  });

  const sensorIdIndex = headerIndex.get("sensor_id");
  const timestampIndex = headerIndex.get("timestamp");
  if (sensorIdIndex === undefined || timestampIndex === undefined) {
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
      throw new Error("sensorcommunity_required_headers_missing");
    }
    return { rows: [], source_records: 0, skipped_outside_day: 0, skipped_null_value: 0 };
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
  const activeMappings = INTEGRITY_POLLUTANT_SCOPED_REPAIR
    ? mappings.filter((mapping) => INTEGRITY_REPAIR_POLLUTANTS.has(mapping.pollutant_code))
    : mappings;

  const dayStartIso = utcDayStartIso(dayUtc);
  const dayEndIso = utcDayEndIso(dayUtc);
  const rows: SourceObservationRow[] = [];
  let sourceRecords = 0;
  let skippedOutsideDay = 0;
  let skippedNullValue = 0;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const columns = lines[lineIndex].split(";");
    const stationRefRaw = (columns[sensorIdIndex] || "").trim();
    sourceRecords += 1;

    const observedAtIso = parseArchiveTimestampToIso(
      columns[timestampIndex] || "",
    );
    if (!observedAtIso) {
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY && activeMappings.some((mapping) => {
        const index = headerIndex.get(mapping.header);
        return index !== undefined && parseCsvNumber(columns[index] || "") !== null;
      })) {
        throw new Error(`sensorcommunity_invalid_timestamp line=${lineIndex + 1}`);
      }
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      skippedOutsideDay += 1;
      continue;
    }
    const stationKnown = Boolean(stationRefRaw) && lookup.station_refs.has(stationRefRaw);

    for (const mapping of activeMappings) {
      const valueIndex = headerIndex.get(mapping.header);
      if (valueIndex === undefined) {
        continue;
      }
      const value = parseCsvNumber(columns[valueIndex] || "");
      if (value === null) {
        skippedNullValue += 1;
        continue;
      }
      if (!stationKnown) {
        if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
          throw new Error(`sensorcommunity_unmapped_observation station_ref=${JSON.stringify(stationRefRaw)} pollutant_code=${mapping.pollutant_code} line=${lineIndex + 1}`);
        }
        continue;
      }
      const bindingKey = stationPollutantKey(stationRefRaw, mapping.pollutant_code);
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY && lookup.ambiguous_station_pollutant_keys.has(bindingKey)) {
        throw new Error(`sensorcommunity_ambiguous_mapping station_ref=${stationRefRaw} pollutant_code=${mapping.pollutant_code}`);
      }
      const binding = lookup.binding_by_station_pollutant.get(bindingKey);
      if (!binding) {
        if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
          throw new Error(`sensorcommunity_unmapped_observation station_ref=${stationRefRaw} pollutant_code=${mapping.pollutant_code}`);
        }
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

  return { rows, source_records: sourceRecords, skipped_outside_day: skippedOutsideDay, skipped_null_value: skippedNullValue };
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

function openaqMirrorFilePaths(
  dayUtc: string,
  locationId: number,
): string[] {
  if (!IS_LOCAL_RUN || !OPENAQ_RAW_MIRROR_ROOT) {
    return [];
  }
  const normalizedDay = parseIsoDayUtc(dayUtc);
  if (!normalizedDay) {
    return [];
  }
  const year = normalizedDay.slice(0, 4);
  const month = normalizedDay.slice(5, 7);
  const yyyymmdd = normalizedDay.replaceAll("-", "");
  const root = OPENAQ_RAW_MIRROR_ROOT.trim();
  if (!root) {
    return [];
  }
  const paths = [
    path.join(
      root,
      `day_utc=${normalizedDay}`,
      `location-${locationId}-${yyyymmdd}.csv.gz`,
    ),
    path.join(
      root,
      `locationid=${locationId}`,
      `year=${year}`,
      `month=${month}`,
      `location-${locationId}-${yyyymmdd}.csv.gz`,
    ),
  ];
  return Array.from(new Set(paths));
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
  const mirrorPaths = openaqMirrorFilePaths(dayUtc, locationId);
  const existingMirrorPath = mirrorPaths.find((mirrorPath) =>
    fs.existsSync(mirrorPath)
  ) || null;

  if (existingMirrorPath) {
    const mirroredBytes = fs.readFileSync(existingMirrorPath);
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

  const mirrorWritePath = existingMirrorPath || mirrorPaths[0] || null;
  if (mirrorWritePath) {
    fs.mkdirSync(path.dirname(mirrorWritePath), { recursive: true });
    fs.writeFileSync(mirrorWritePath, downloadedBytes);
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
    mirror_written: Boolean(mirrorWritePath),
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

function normalizeUkAirSourceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

type SosSourceLabelRegistryStatus = "mapped" | "ignore" | "review";
type SosSourceLabelRegistryEntry = {
  normalised_source_label: string;
  status: SosSourceLabelRegistryStatus;
  pollutant_code: string | null;
  expected_uom: string | null;
  raw_label_variants: string[];
  observed_units: string[];
  reviewed_at_utc: string | null;
  review_notes: string | null;
};
type SosSourceLabelRegistrySnapshot = {
  source_file: string;
  file_sha256: string;
  content_sha256: string;
  entries: Map<string, SosSourceLabelRegistryEntry>;
};

function canonicalRegistryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRegistryJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalRegistryJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

let sosSourceLabelRegistrySnapshot: SosSourceLabelRegistrySnapshot | null | undefined;

export function loadSosSourceLabelRegistrySnapshot(): SosSourceLabelRegistrySnapshot | null {
  if (sosSourceLabelRegistrySnapshot !== undefined) return sosSourceLabelRegistrySnapshot;
  const sourceFile = optionalEnv("UK_AQ_BACKFILL_SOS_SOURCE_LABEL_REGISTRY_FILE");
  if (!sourceFile) return sosSourceLabelRegistrySnapshot = null;
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`sos_source_label_registry_file_missing path=${sourceFile}`);
  }
  const text = fs.readFileSync(sourceFile, "utf8");
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (Number(payload.schema_version) !== 1 || Number(payload.connector_id) !== 1 || !Array.isArray(payload.labels)) {
    throw new Error(`sos_source_label_registry_invalid path=${sourceFile}`);
  }
  const declaredContentHash = String(payload.registry_content_sha256 || "");
  const contentPayload = { ...payload };
  delete contentPayload.registry_content_sha256;
  if (!/^[a-f0-9]{64}$/.test(declaredContentHash) ||
    sha256Hex(canonicalRegistryJson(contentPayload)) !== declaredContentHash) {
    throw new Error(`sos_source_label_registry_content_hash_invalid path=${sourceFile}`);
  }
  const entries = new Map<string, SosSourceLabelRegistryEntry>();
  for (const raw of payload.labels) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as SosSourceLabelRegistryEntry;
    if (
      !entry.normalised_source_label ||
      !["mapped", "ignore", "review"].includes(entry.status)
    ) {
      throw new Error(`sos_source_label_registry_invalid_entry path=${sourceFile}`);
    }
    if (!Array.isArray(entry.raw_label_variants) || !Array.isArray(entry.observed_units) ||
      (entry.reviewed_at_utc !== null && typeof entry.reviewed_at_utc !== "string") ||
      (entry.review_notes !== null && typeof entry.review_notes !== "string") ||
      entries.has(entry.normalised_source_label)) {
      throw new Error(`sos_source_label_registry_invalid_entry path=${sourceFile}`);
    }
    if (
      (entry.status === "mapped" &&
        (!['pm25', 'pm10', 'no2', 'o3'].includes(String(entry.pollutant_code || "")) ||
          !String(entry.expected_uom || "").trim())) ||
      (entry.status !== "mapped" && entry.pollutant_code !== null)
    ) {
      throw new Error(`sos_source_label_registry_invalid_decision path=${sourceFile}`);
    }
    entries.set(entry.normalised_source_label, entry);
  }
  return sosSourceLabelRegistrySnapshot = {
    source_file: sourceFile,
    file_sha256: sha256Hex(text),
    content_sha256: declaredContentHash,
    entries,
  };
}

function isPossibleSupportedSosSourceLabel(label: string): boolean {
  const compact = label.replace(/[^a-z0-9.]+/g, "");
  return /pm2\.5|pm25|pm10|nitrogendioxide|no2|ozone|o3/.test(compact);
}

export function normaliseConcentrationUnitForComparison(
  value: string | null | undefined,
): string {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/³/g, "3")
    .replace(/[−–]/g, "-")
    .replace(/\([^)]*\)$/g, "")
    .replace(/\s+/g, "");
  const aliases = new Map<string, string>([
    ["ug/m3", "ug/m3"],
    ["ugm-3", "ug/m3"],
    ["mg/m3", "mg/m3"],
    ["mgm-3", "mg/m3"],
  ]);
  return aliases.get(compact) || compact;
}

function parseUkAirCsvDay(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseUkAirGmtHourEnding(dayUtc: string, value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 24 || minute < 0 || minute > 59) return null;
  const start = Date.parse(`${dayUtc}T00:00:00.000Z`);
  return new Date(start + ((hour * 60 + minute) - 60) * 60_000).toISOString();
}

export type UkAirFlatFileParseResult = {
  rows: SourceObservationRow[];
  source_records: number;
  mapped_records: number;
  skipped_other_days: number;
  skipped_invalid_rows: number;
  skipped_unselected_pollutant_rows: number;
  source_label_classifications: Array<Record<string, unknown>>;
  blocked_target_day_rows: number;
  blocked_target_day_row_samples: Record<string, unknown>[];
  skipped_ignored_properties: number;
  units: string[];
};

export function parseUkAirFlatFileObservations(args: {
  dayUtc: string;
  siteRef: string;
  csvText: string;
  mappings: SosSiteTimeseriesRef[];
  propertyMappings: ObservedPropertyMapping[];
}): UkAirFlatFileParseResult {
  // This is intentionally lazy: non-SOS adapters never read an SOS snapshot.
  const registry = loadSosSourceLabelRegistrySnapshot();
  const lines = args.csvText.split(/\r?\n/);
  if (!lines.some((line) => line.trim().toLowerCase() === "all data gmt hour ending")) {
    throw new Error(`UK-AIR CSV ${args.siteRef} does not declare All Data GMT hour ending`);
  }

  const mappingsByPollutant = new Map<string, SosSiteTimeseriesRef[]>();
  for (const mapping of args.mappings) {
    if (mapping.site_ref.toUpperCase() !== args.siteRef.toUpperCase()) continue;
    if (!isSosMappingValidForDay(mapping, args.dayUtc)) continue;
    const rows = mappingsByPollutant.get(mapping.pollutant_code) || [];
    rows.push(mapping);
    mappingsByPollutant.set(mapping.pollutant_code, rows);
  }

  const result: UkAirFlatFileParseResult = {
    rows: [],
    source_records: 0,
    mapped_records: 0,
    skipped_other_days: 0,
    skipped_invalid_rows: 0,
    skipped_unselected_pollutant_rows: 0,
    source_label_classifications: [],
    blocked_target_day_rows: 0,
    blocked_target_day_row_samples: [],
    skipped_ignored_properties: 0,
    units: [],
  };
  const units = new Set<string>();
  const propertyMappingsByLabel = new Map<string, ObservedPropertyMapping[]>();
  for (const mapping of args.propertyMappings) {
    if (mapping.connector_id !== 1) continue;
    const label = normalizeUkAirSourceLabel(mapping.source_label);
    const rows = propertyMappingsByLabel.get(label) || [];
    rows.push(mapping);
    propertyMappingsByLabel.set(label, rows);
  }
  type ColumnBinding = {
    valueIndex: number;
    statusIndex: number;
    unitIndex: number;
    sourceLabel: string;
    normalisedSourceLabel: string;
    property: ObservedPropertyMapping;
    timeseries: SosSiteTimeseriesRef;
    expectedUom: string;
    decisionSource: "integrity_registry" | "integrity_registry_and_core" | "core_mapping";
    units: Set<string>;
    targetDayNonNullRowCount: number;
    targetDayBlankUnitRowCount: number;
    headerSectionIndex: number;
    pendingRows: Array<{ observedAt: string; value: number; status: string | null; unit: string }>;
  };
  let columnBindings: ColumnBinding[] = [];
  const mappedSelectedSourceLabelColumns: ColumnBinding[] = [];
  let headerSectionIndex = 0;
  let unselectedPollutantValueIndexes: number[] = [];
  type SkippedSourceLabelColumn = {
    valueIndex: number;
    sourceLabel: string;
    normalisedSourceLabel: string;
    classification: "ignore" | "review" | "unregistered" | "mapped_out_of_scope";
    units: Set<string>;
    targetDayNonNullRowCount: number;
  };
  let skippedSourceLabelColumns: SkippedSourceLabelColumn[] = [];
  const allSkippedSourceLabelColumns: SkippedSourceLabelColumn[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    const cells = parseCsvRow(line, ",").map((cell) => cell.trim());
    if (
      String(cells[0] || "").toLowerCase() === "date" &&
      String(cells[1] || "").toLowerCase() === "time"
    ) {
      headerSectionIndex += 1;
      columnBindings = [];
      unselectedPollutantValueIndexes = [];
      skippedSourceLabelColumns = [];
      for (let valueIndex = 2; valueIndex < cells.length; valueIndex += 3) {
        const sourceLabel = normalizeUkAirSourceLabel(cells[valueIndex] || "");
        if (!sourceLabel) continue;
        const registryEntry = registry?.entries.get(sourceLabel);
        const skipSourceLabel = (
          classification: SkippedSourceLabelColumn["classification"],
        ) => {
          const skipped: SkippedSourceLabelColumn = {
            valueIndex,
            sourceLabel: String(cells[valueIndex] || "").trim(),
            normalisedSourceLabel: sourceLabel,
            classification,
            units: new Set<string>(),
            targetDayNonNullRowCount: 0,
          };
          skippedSourceLabelColumns.push(skipped);
          allSkippedSourceLabelColumns.push(skipped);
        };
        if (registryEntry?.status === "ignore" || registryEntry?.status === "review") {
          skipSourceLabel(registryEntry.status);
          continue;
        }
        if (registry && !registryEntry) {
          skipSourceLabel("unregistered");
          continue;
        }
        const candidates = propertyMappingsByLabel.get(sourceLabel) || [];
        const active = candidates.filter((mapping) => mapping.is_active);
        let property: ObservedPropertyMapping;
        let pollutantCode: string;
        let decisionSource: "integrity_registry" | "integrity_registry_and_core" | "core_mapping";
        if (registryEntry?.status === "mapped") {
          pollutantCode = String(registryEntry.pollutant_code || "");
          if (!['pm25', 'pm10', 'no2', 'o3'].includes(pollutantCode) || !registryEntry.expected_uom?.trim()) {
            throw new Error(`sos_source_label_registry_invalid_mapped_decision source_label=${JSON.stringify(sourceLabel)}`);
          }
          if (candidates.length) {
            if (active.length !== 1) {
              throw new Error(`source_label_ambiguous connector_id=1 source_label=${JSON.stringify(sourceLabel)} site_ref=${args.siteRef} day_utc=${args.dayUtc} matches=${active.length}`);
            }
            property = active[0];
            if (property.mapping_kind !== "raw_observed_property" ||
              String(property.observed_property_code || "").trim() !== pollutantCode) {
              throw new Error(`sos_source_label_registry_mapping_mismatch source_label=${JSON.stringify(sourceLabel)} registry_pollutant_code=${pollutantCode} observed_property_code=${property.observed_property_code} mapping_kind=${property.mapping_kind}`);
            }
            decisionSource = "integrity_registry_and_core";
          } else {
            property = {
              connector_id: 1, source_label: String(cells[valueIndex] || "").trim(),
              source_uom: registryEntry.expected_uom, observed_property_id: null,
              observed_property_code: pollutantCode, mapping_kind: "raw_observed_property",
              is_aqi_eligible: ['pm25', 'pm10', 'no2'].includes(pollutantCode), is_active: true,
            };
            decisionSource = "integrity_registry";
          }
        } else {
          if (!candidates.length) {
            throw new Error(`unmapped_source_label connector_id=1 source_label=${JSON.stringify(sourceLabel)} site_ref=${args.siteRef} day_utc=${args.dayUtc}`);
          }
          if (active.length !== 1) {
            throw new Error(`source_label_ambiguous connector_id=1 source_label=${JSON.stringify(sourceLabel)} site_ref=${args.siteRef} day_utc=${args.dayUtc} matches=${active.length}`);
          }
          property = active[0];
          if (property.mapping_kind === "ignored") {
            result.skipped_ignored_properties += 1;
            continue;
          }
          if (property.mapping_kind !== "raw_observed_property") {
            throw new Error(`unsupported_mapping_kind connector_id=1 source_label=${JSON.stringify(sourceLabel)} mapping_kind=${property.mapping_kind} site_ref=${args.siteRef} day_utc=${args.dayUtc}`);
          }
          pollutantCode = String(property.observed_property_code || "").trim();
          decisionSource = "core_mapping";
        }
        if (!/^[a-z0-9_]+$/.test(pollutantCode)) {
          throw new Error(`invalid_observed_property_code source_label=${JSON.stringify(sourceLabel)} observed_property_code=${JSON.stringify(pollutantCode)}`);
        }
        if (
          INTEGRITY_POLLUTANT_SCOPED_REPAIR &&
          !INTEGRITY_REPAIR_POLLUTANTS.has(pollutantCode)
        ) {
          unselectedPollutantValueIndexes.push(valueIndex);
          skipSourceLabel("mapped_out_of_scope");
          continue;
        }
        const timeseries = mappingsByPollutant.get(pollutantCode) || [];
        if (!timeseries.length) {
          throw new Error(`unmapped_timeseries site_ref=${args.siteRef} source_label=${JSON.stringify(sourceLabel)} observed_property_code=${pollutantCode} day_utc=${args.dayUtc}`);
        }
        if (timeseries.length !== 1) {
          throw new Error(`ambiguous_timeseries_mapping site_ref=${args.siteRef} source_label=${JSON.stringify(sourceLabel)} observed_property_code=${pollutantCode} day_utc=${args.dayUtc} matches=${timeseries.length}`);
        }
        const binding: ColumnBinding = {
          valueIndex,
          statusIndex: valueIndex + 1,
          unitIndex: valueIndex + 2,
          sourceLabel: String(cells[valueIndex] || "").trim(),
          normalisedSourceLabel: sourceLabel,
          property,
          timeseries: timeseries[0],
          expectedUom: String(
            registryEntry?.expected_uom || property.source_uom || "",
          ).trim(),
          decisionSource,
          units: new Set<string>(),
          targetDayNonNullRowCount: 0,
          targetDayBlankUnitRowCount: 0,
          headerSectionIndex,
          pendingRows: [],
        };
        columnBindings.push(binding);
        mappedSelectedSourceLabelColumns.push(binding);
      }
      continue;
    }
    if (
      !columnBindings.length &&
      !skippedSourceLabelColumns.length &&
      !unselectedPollutantValueIndexes.length
    ) continue;

    const sourceDay = parseUkAirCsvDay(cells[0] || "");
    if (!sourceDay) {
      result.skipped_invalid_rows += 1;
      result.blocked_target_day_rows += 1;
      if (
        result.blocked_target_day_row_samples.length <
          INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT
      ) {
        result.blocked_target_day_row_samples.push({
          reason: "unparseable_observation_date",
          site_ref: args.siteRef,
          line_number: lineIndex + 1,
          date: String(cells[0] || "").trim(),
          time: String(cells[1] || "").trim(),
        });
      }
      continue;
    }
    result.source_records += 1;
    // Unit evidence belongs to the header section, not only to the target
    // day.  A blank target-day unit may inherit only this section's proven
    // compatible non-empty unit evidence.
    for (const binding of columnBindings) {
      const value = toFiniteNumber(cells[binding.valueIndex]);
      if (value === null) continue;
      const unit = String(cells[binding.unitIndex] || "").trim();
      if (unit) binding.units.add(unit);
    }
    if (sourceDay !== args.dayUtc) {
      result.skipped_other_days += 1;
      continue;
    }
    const observedAt = parseUkAirGmtHourEnding(sourceDay, cells[1] || "");
    if (!observedAt) {
      result.skipped_invalid_rows += 1;
      result.blocked_target_day_rows += 1;
      if (
        result.blocked_target_day_row_samples.length <
          INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT
      ) {
        result.blocked_target_day_row_samples.push({
          reason: "invalid_gmt_hour_ending",
          site_ref: args.siteRef,
          line_number: lineIndex + 1,
          date: String(cells[0] || "").trim(),
          time: String(cells[1] || "").trim(),
        });
      }
      continue;
    }
    for (const valueIndex of unselectedPollutantValueIndexes) {
      if (toFiniteNumber(cells[valueIndex]) !== null) {
        result.skipped_unselected_pollutant_rows += 1;
      }
    }
    for (const skipped of skippedSourceLabelColumns) {
      if (toFiniteNumber(cells[skipped.valueIndex]) !== null) {
        skipped.targetDayNonNullRowCount += 1;
        const unit = String(cells[skipped.valueIndex + 2] || "").trim();
        if (unit) skipped.units.add(unit);
      }
    }
    for (const binding of columnBindings) {
      const value = toFiniteNumber(cells[binding.valueIndex]);
      if (value === null) continue;
      const unit = String(cells[binding.unitIndex] || "").trim();
      binding.targetDayNonNullRowCount += 1;
      if (!unit) binding.targetDayBlankUnitRowCount += 1;
      if (unit) units.add(unit);
      binding.pendingRows.push({ observedAt, value, unit, status: String(cells[binding.statusIndex] || "").trim() || null });
    }
  }
  for (const binding of mappedSelectedSourceLabelColumns) {
    const expectedUnit = binding.expectedUom;
    const normalisedExpectedUnit = normaliseConcentrationUnitForComparison(expectedUnit);
    const observedUnits = Array.from(binding.units).sort();
    const normalisedUnits = observedUnits.map(normaliseConcentrationUnitForComparison);
    const hasTargetDayValues = binding.targetDayNonNullRowCount > 0;
    if (!expectedUnit || !normalisedExpectedUnit ||
      (hasTargetDayValues && !observedUnits.length) ||
      normalisedUnits.some((unit) => unit !== normalisedExpectedUnit)) {
      throw new Error(`unit_mismatch connector_id=1 site_ref=${args.siteRef} day_utc=${args.dayUtc} source_label=${JSON.stringify(binding.sourceLabel)} observed_property_code=${binding.property.observed_property_code} header_section_index=${binding.headerSectionIndex} expected_raw_unit=${JSON.stringify(expectedUnit)} expected_normalised_unit=${JSON.stringify(normalisedExpectedUnit)} observed_raw_units=${JSON.stringify(observedUnits)} observed_normalised_units=${JSON.stringify(normalisedUnits)} target_day_non_null_row_count=${binding.targetDayNonNullRowCount} target_day_blank_unit_row_count=${binding.targetDayBlankUnitRowCount}`);
    }
    for (const row of binding.pendingRows) {
      result.rows.push({
        timeseries_id: binding.timeseries.timeseries_id,
        station_id: binding.timeseries.station_id,
        pollutant_code: String(binding.property.observed_property_code),
        observed_at: row.observedAt,
        value: row.value,
        status: row.status,
        source_parameter: row.unit ? `uk_air_flat_file:${row.unit}` : `uk_air_flat_file:${expectedUnit}`,
      });
      result.mapped_records += 1;
    }
  }
  result.units = Array.from(units).sort();
  result.source_label_classifications = [
    ...mappedSelectedSourceLabelColumns.map((column) => ({
      source_label: column.sourceLabel,
      normalised_source_label: column.normalisedSourceLabel,
      classification: "mapped_selected",
      site_ref: args.siteRef,
      observed_units: Array.from(column.units).sort(),
      target_day_non_null_row_count: column.targetDayNonNullRowCount,
      target_day_blank_unit_row_count: column.targetDayBlankUnitRowCount,
      header_section_index: column.headerSectionIndex,
      section_normalised_units: Array.from(column.units).map(normaliseConcentrationUnitForComparison).sort(),
      expected_unit: column.expectedUom,
      expected_normalised_unit: normaliseConcentrationUnitForComparison(column.expectedUom),
      possible_supported_pollutant_label: false,
      mapping_decision_source: column.decisionSource,
    })),
    ...allSkippedSourceLabelColumns.map((column) => ({
      source_label: column.sourceLabel,
      normalised_source_label: column.normalisedSourceLabel,
      classification: column.classification,
      site_ref: args.siteRef,
      observed_units: Array.from(column.units).sort(),
      target_day_non_null_row_count: column.targetDayNonNullRowCount,
      possible_supported_pollutant_label:
        (column.classification === "review" || column.classification === "unregistered") &&
        isPossibleSupportedSosSourceLabel(column.normalisedSourceLabel),
    })),
  ];
  return result;
}

function ukAirFlatFilePath(root: string, siteRef: string, year: number): string {
  return path.join(
    root,
    `site_ref=${encodeURIComponent(siteRef.toUpperCase())}`,
    `year=${year}`,
    `${siteRef.toUpperCase()}_${year}.csv`,
  );
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

export function parseOpenaqCsvObservations(args: {
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
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
      throw new Error(`openaq_required_headers_missing location_id=${locationId}`);
    }
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
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
        throw new Error(`openaq_invalid_location_identity expected=${locationId} actual=${JSON.stringify(rowLocationRaw)} line=${lineIndex + 1}`);
      }
      continue;
    }

    const parameterRaw = String(columns[parameterIndex] || "").trim();
    const pollutantCode = parseSourcePollutantCode(parameterRaw);
    if (!pollutantCode) {
      skippedUnknownParameter += 1;
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
        const unknownObservedAt = parseArchiveTimestampToIso(columns[datetimeIndex] || "");
        const unknownValue = parseCsvNumber(columns[valueIndex] || "");
        if (unknownObservedAt && unknownObservedAt >= dayStartIso && unknownObservedAt < dayEndIso && unknownValue !== null) {
          throw new Error(`openaq_observation_missing_canonical_pollutant location_id=${locationId} parameter=${JSON.stringify(parameterRaw)} line=${lineIndex + 1}`);
        }
      }
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
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY && !observedAtIso && value !== null) {
        throw new Error(`openaq_observation_invalid_timestamp location_id=${locationId} line=${lineIndex + 1}`);
      }
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      skippedOutsideDay += 1;
      continue;
    }

    const sensorRef = String(columns[sensorIdIndex] || "").trim();
    const sensorPollutantKey = stationPollutantKey(sensorRef, pollutantCode);
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY && sensorRef &&
      lookup.ambiguous_timeseries_ref_pollutant_keys.has(sensorPollutantKey)) {
      throw new Error(`openaq_ambiguous_sensor_pollutant_mapping sensor_ref=${sensorRef} pollutant_code=${pollutantCode}`);
    }
    const bySensorPollutant = sensorRef
      ? lookup.binding_by_timeseries_ref_pollutant.get(
        sensorPollutantKey,
      ) || null
      : null;
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY && sensorRef && !bySensorPollutant &&
      lookup.ambiguous_timeseries_ref_keys.has(sensorRef)) {
      throw new Error(`openaq_ambiguous_sensor_mapping sensor_ref=${sensorRef}`);
    }
    const bySensor = sensorRef
      ? lookup.binding_by_timeseries_ref.get(sensorRef) || null
      : null;
    const locationPollutantKey = stationPollutantKey(String(locationId), pollutantCode);
    if (INTEGRITY_COMPLETE_CONNECTOR_DAY && !bySensorPollutant &&
      !(bySensor && bySensor.pollutant_code === pollutantCode) &&
      lookup.ambiguous_station_pollutant_keys.has(locationPollutantKey)) {
      throw new Error(`openaq_ambiguous_location_pollutant_mapping location_id=${locationId} pollutant_code=${pollutantCode}`);
    }
    const byStationPollutant = lookup.binding_by_station_pollutant.get(
      locationPollutantKey,
    ) || null;
    const binding = bySensorPollutant ||
      (bySensor && bySensor.pollutant_code === pollutantCode
        ? bySensor
        : null) ||
      byStationPollutant;
    if (!binding) {
      skippedUnknownBinding += 1;
      if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
        throw new Error(`openaq_unmapped_observation location_id=${locationId} sensor_ref=${JSON.stringify(sensorRef)} pollutant_code=${pollutantCode}`);
      }
      continue;
    }
    const canonicalPollutant = parseSourcePollutantCode(String(binding.pollutant_code || ""));
    if (!canonicalPollutant) {
      throw new Error(`openaq_mapping_missing_canonical_pollutant timeseries_id=${binding.timeseries_id}`);
    }

    rows.push({
      timeseries_id: binding.timeseries_id,
      station_id: binding.station_id,
      pollutant_code: canonicalPollutant,
      observed_at: observedAtIso,
      value,
      source_parameter: parameterRaw,
    } as SourceObservationRow);
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

type IntegrityDuplicateSourceEvidence = {
  canonical_observation_rows: SourceObservationRow[];
  duplicate_canonical_row_count: number;
  duplicate_canonical_row_identity_samples: Record<string, unknown>[];
  uncanonicalisable_source_row_count: number;
  blocked_row_samples: Record<string, unknown>[];
};

function normalizeObservationValueIdentity(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSourceObservationForV2(
  row: SourceObservationRow,
): SourceObservationRow | null {
  const timeseriesId = Number(row.timeseries_id);
  const stationId = Number(row.station_id);
  const parsedTimestamp = Date.parse(String(row.observed_at || "").trim());
  const value = Number(row.value);
  let pollutantCode: string;
  try {
    pollutantCode = normalizePollutantCodeForR2Path(row.pollutant_code);
  } catch {
    return null;
  }
  if (
    !Number.isInteger(timeseriesId) || timeseriesId <= 0 ||
    !Number.isInteger(stationId) || stationId <= 0 ||
    !Number.isFinite(parsedTimestamp) || !Number.isFinite(value)
  ) {
    return null;
  }
  return {
    timeseries_id: Math.trunc(timeseriesId),
    station_id: Math.trunc(stationId),
    pollutant_code: pollutantCode,
    observed_at: new Date(parsedTimestamp).toISOString(),
    value: Object.is(value, -0) ? 0 : value,
    status: row.status == null ? null : String(row.status),
  };
}

function inspectIntegritySourceRowsForBlockingEvidence(
  rows: SourceObservationRow[],
  connectorId: number,
): IntegrityDuplicateSourceEvidence {
  const occurrencesByCanonicalKey = new Map<
    string,
    { count: number; identities: Record<string, unknown>[] }
  >();
  const blockedRowSamples: Record<string, unknown>[] = [];
  const duplicateCanonicalRowIdentitySamples: Record<string, unknown>[] = [];
  const canonicalObservationRows: SourceObservationRow[] = [];
  let uncanonicalisableSourceRowCount = 0;

  for (const row of rows) {
    const canonical = normalizeSourceObservationForV2(row);
    if (!canonical) {
      uncanonicalisableSourceRowCount += 1;
      if (blockedRowSamples.length < INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT) {
        blockedRowSamples.push({
          reason: "source_row_failed_existing_canonical_normalisation",
          row: {
            connector_id: connectorId,
            timeseries_id: row.timeseries_id,
            station_id: row.station_id,
            pollutant_code: row.pollutant_code,
            observed_at: row.observed_at,
            value: row.value,
            status: row.status ?? null,
          },
        });
      }
      continue;
    }
    canonicalObservationRows.push(canonical);
    const canonicalIdentity = {
      connector_id: connectorId,
      station_id: canonical.station_id,
      timeseries_id: canonical.timeseries_id,
      pollutant_code: canonical.pollutant_code,
      observed_at: canonical.observed_at,
      value: canonical.value,
      value_identity: normalizeObservationValueIdentity(canonical.value),
      status: canonical.status ?? null,
    };
    const canonicalKey = JSON.stringify(canonicalIdentity);
    const occurrence = occurrencesByCanonicalKey.get(canonicalKey) || {
      count: 0,
      identities: [],
    };
    occurrence.count += 1;
    if (occurrence.identities.length < 2) {
      occurrence.identities.push(canonicalIdentity);
    }
    occurrencesByCanonicalKey.set(canonicalKey, occurrence);
  }

  let duplicateCanonicalRowCount = 0;
  for (const [canonicalKey, occurrence] of Array.from(
    occurrencesByCanonicalKey.entries(),
  ).sort(([left], [right]) => left.localeCompare(right))) {
    if (occurrence.count <= 1) continue;
    duplicateCanonicalRowCount += occurrence.count - 1;
    const duplicateSample = {
      reason: "duplicate_canonical_source_row",
      canonical_identity: occurrence.identities[0],
      duplicate_row_count: occurrence.count - 1,
      identities: occurrence.identities,
    };
    if (
      duplicateCanonicalRowIdentitySamples.length <
        INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT
    ) {
      duplicateCanonicalRowIdentitySamples.push(duplicateSample);
    }
    if (blockedRowSamples.length < INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT) {
      blockedRowSamples.push(duplicateSample);
    }
  }

  return {
    canonical_observation_rows: canonicalObservationRows,
    duplicate_canonical_row_count: duplicateCanonicalRowCount,
    duplicate_canonical_row_identity_samples:
      duplicateCanonicalRowIdentitySamples,
    uncanonicalisable_source_row_count: uncanonicalisableSourceRowCount,
    blocked_row_samples: blockedRowSamples,
  };
}

function sourceObservationsToObsHistoryRows(
  rows: SourceObservationRow[],
): ObsHistoryRow[] {
  return rows.map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at,
    value: row.value,
    status: row.status ?? null,
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
  const wideRows = helperRowsToAqilevelHistoryRowsCore(helperRows) as Array<
    Record<string, unknown>
  >;
  const normalizedRows: AqilevelsHistoryRow[] = [];

  for (const row of wideRows) {
    const pollutantCode = parsePollutantCode(row.pollutant_code) as
      | "no2"
      | "pm25"
      | "pm10"
      | null;
    if (!pollutantCode) {
      continue;
    }

    const hourlyMean = toSafeNumber(row.hourly_mean_ugm3) ??
      (pollutantCode === "no2"
        ? toSafeNumber(row.no2_hourly_mean_ugm3)
        : pollutantCode === "pm25"
        ? toSafeNumber(row.pm25_hourly_mean_ugm3)
        : toSafeNumber(row.pm10_hourly_mean_ugm3));
    const rolling24hMean = pollutantCode === "no2"
      ? null
      : toSafeNumber(row.rolling24h_mean_ugm3) ??
        (pollutantCode === "pm25"
          ? toSafeNumber(row.pm25_rolling24h_mean_ugm3)
          : toSafeNumber(row.pm10_rolling24h_mean_ugm3));
    const daqiInputValue = pollutantCode === "no2" ? hourlyMean : rolling24hMean;
    const daqiInputAveragingCode = daqiAveragingCodeForPollutant(pollutantCode);
    const daqiSourceCount = daqiInputValue === null
      ? null
      : daqiInputAveragingCode === "rolling_24h_mean"
      ? 24
      : toSafeWholeNumber(row.hourly_sample_count);
    const daqiRequiredCount = daqiInputAveragingCode === "rolling_24h_mean" ? 24 : 1;
    const daqiStatus = daqiInputValue === null ? "missing_input" : "ok";
    const eaqiInputValue = hourlyMean;
    const eaqiSourceCount = eaqiInputValue === null ? null : toSafeWholeNumber(row.hourly_sample_count);
    const eaqiStatus = eaqiInputValue === null ? "missing_input" : "ok";
    const daqiIndexLevel = toSafeNumber(row.daqi_index_level);
    const eaqiIndexLevel = toSafeNumber(row.eaqi_index_level);

    normalizedRows.push({
      timeseries_id: Number(row.timeseries_id),
      station_id: row.station_id === null || row.station_id === undefined
        ? null
        : Number(row.station_id),
      connector_id: Number(row.connector_id),
      pollutant_code: pollutantCode,
      timestamp_hour_utc: String(row.timestamp_hour_utc || ""),
      daqi_input_value_ugm3: daqiInputValue,
      daqi_input_averaging_code: daqiInputAveragingCode,
      daqi_source_observation_count: daqiSourceCount,
      daqi_required_observation_count: daqiRequiredCount,
      daqi_calculation_status: daqiStatus,
      daqi_missing_reason: daqiStatus === "ok" ? null : daqiStatus,
      eaqi_input_value_ugm3: eaqiInputValue,
      eaqi_input_averaging_code: "hourly_mean",
      eaqi_source_observation_count: eaqiSourceCount,
      eaqi_required_observation_count: 1,
      eaqi_calculation_status: eaqiStatus,
      eaqi_missing_reason: eaqiStatus === "ok" ? null : eaqiStatus,
      hourly_mean_ugm3: hourlyMean,
      rolling24h_mean_ugm3: rolling24hMean,
      hourly_sample_count: toSafeNumber(row.hourly_sample_count),
      daqi_index_level: daqiIndexLevel,
      eaqi_index_level: eaqiIndexLevel,
      no2_hourly_mean_ugm3: pollutantCode === "no2" ? hourlyMean : null,
      pm25_hourly_mean_ugm3: pollutantCode === "pm25" ? hourlyMean : null,
      pm10_hourly_mean_ugm3: pollutantCode === "pm10" ? hourlyMean : null,
      pm25_rolling24h_mean_ugm3: pollutantCode === "pm25" ? rolling24hMean : null,
      pm10_rolling24h_mean_ugm3: pollutantCode === "pm10" ? rolling24hMean : null,
      daqi_no2_index_level: pollutantCode === "no2" ? daqiIndexLevel : null,
      daqi_pm25_rolling24h_index_level: pollutantCode === "pm25" ? daqiIndexLevel : null,
      daqi_pm10_rolling24h_index_level: pollutantCode === "pm10" ? daqiIndexLevel : null,
      eaqi_no2_index_level: pollutantCode === "no2" ? eaqiIndexLevel : null,
      eaqi_pm25_index_level: pollutantCode === "pm25" ? eaqiIndexLevel : null,
      eaqi_pm10_index_level: pollutantCode === "pm10" ? eaqiIndexLevel : null,
      algorithm_version: "aqilevels_hourly_v1",
      computed_at_utc: null,
      updated_at: null,
    });
  }

  return normalizedRows.filter((row) =>
    Number.isInteger(row.timeseries_id) &&
    row.timeseries_id > 0 &&
    (
      row.station_id === null
      || (
        Number.isInteger(row.station_id) &&
        row.station_id > 0
      )
    ) &&
    Number.isInteger(row.connector_id) &&
    row.connector_id > 0 &&
    !!parseIsoHour(row.timestamp_hour_utc)
  );
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
        appendRowsSafe(rows, pageRows);

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

function parseHistoryIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const parsedMs = Date.parse(value);
    if (!Number.isNaN(parsedMs)) {
      return new Date(parsedMs).toISOString();
    }
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

async function readObsHistoryRowsFromParquetBytes(
  bytes: Uint8Array,
): Promise<ObsHistoryRow[]> {
  const file = toArrayBufferView(bytes);
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) {
    return [];
  }
  const [timeseriesValues, observedAtValues, valueValues] = await Promise.all([
    readParquetColumnValues(file, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "observed_at", 0, rowCount),
    readParquetColumnValues(file, metadata, "value", 0, rowCount),
  ]);

  const rows: ObsHistoryRow[] = [];
  const length = Math.min(
    timeseriesValues.length,
    observedAtValues.length,
    valueValues.length,
  );
  for (let index = 0; index < length; index += 1) {
    const timeseriesId = Number(timeseriesValues[index]);
    const observedAtIso = parseHistoryIsoTimestamp(observedAtValues[index]);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !observedAtIso) {
      continue;
    }
    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      observed_at: observedAtIso,
      value: toSafeNumber(valueValues[index]),
    });
  }
  return rows;
}

async function readAqiHistoryRowsFromParquetBytes(
  bytes: Uint8Array,
): Promise<AqilevelsHistoryRow[]> {
  const file = toArrayBufferView(bytes);
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) {
    return [];
  }

  const [
    timeseriesValues,
    stationValues,
    pollutantValues,
    timestampValues,
    hourlyValues,
    rollingValues,
    sampleValues,
    daqiValues,
    eaqiValues,
  ] = await Promise.all([
    readParquetColumnValues(file, metadata, "timeseries_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "station_id", 0, rowCount),
    readParquetColumnValues(file, metadata, "pollutant_code", 0, rowCount),
    readParquetColumnValues(file, metadata, "timestamp_hour_utc", 0, rowCount),
    readParquetColumnValues(file, metadata, "hourly_mean_ugm3", 0, rowCount),
    readParquetColumnValues(file, metadata, "rolling24h_mean_ugm3", 0, rowCount),
    readParquetColumnValues(file, metadata, "hourly_sample_count", 0, rowCount),
    readParquetColumnValues(file, metadata, "daqi_index_level", 0, rowCount),
    readParquetColumnValues(file, metadata, "eaqi_index_level", 0, rowCount),
  ]);

  const rows: AqilevelsHistoryRow[] = [];
  const length = Math.min(
    timeseriesValues.length,
    stationValues.length,
    pollutantValues.length,
    timestampValues.length,
    hourlyValues.length,
    rollingValues.length,
    sampleValues.length,
    daqiValues.length,
    eaqiValues.length,
  );
  for (let index = 0; index < length; index += 1) {
    const timeseriesId = Number(timeseriesValues[index]);
    const timestampHourUtc = parseHistoryIsoTimestamp(timestampValues[index]);
    const pollutant = parsePollutantCode(pollutantValues[index]);
    if (
      !Number.isInteger(timeseriesId) ||
      timeseriesId <= 0 ||
      !timestampHourUtc ||
      !pollutant
    ) {
      continue;
    }
    const stationIdRaw = Number(stationValues[index]);
    const hourlyMean = toSafeNumber(hourlyValues[index]);
    const rolling24hMean = toSafeNumber(rollingValues[index]);
    const daqiInputAveragingCode = daqiAveragingCodeForPollutant(pollutant);
    const daqiInputValue = pollutant === "no2" ? hourlyMean : rolling24hMean;
    const daqiStatus = daqiInputValue === null ? "missing_input" : "ok";
    const eaqiInputValue = hourlyMean;
    const eaqiStatus = eaqiInputValue === null ? "missing_input" : "ok";
    const daqiIndexLevel = toSafeNumber(daqiValues[index]);
    const eaqiIndexLevel = toSafeNumber(eaqiValues[index]);
    const hourlySampleCount = toSafeNumber(sampleValues[index]);
    rows.push({
      timeseries_id: Math.trunc(timeseriesId),
      station_id: Number.isInteger(stationIdRaw) && stationIdRaw > 0
        ? Math.trunc(stationIdRaw)
        : null,
      connector_id: 0,
      pollutant_code: pollutant,
      timestamp_hour_utc: timestampHourUtc,
      daqi_input_value_ugm3: daqiInputValue,
      daqi_input_averaging_code: daqiInputAveragingCode,
      daqi_source_observation_count: daqiInputValue === null
        ? null
        : daqiInputAveragingCode === "rolling_24h_mean"
        ? 24
        : toSafeWholeNumber(hourlySampleCount),
      daqi_required_observation_count: daqiInputAveragingCode === "rolling_24h_mean" ? 24 : 1,
      daqi_calculation_status: daqiStatus,
      daqi_missing_reason: daqiStatus === "ok" ? null : daqiStatus,
      eaqi_input_value_ugm3: eaqiInputValue,
      eaqi_input_averaging_code: "hourly_mean",
      eaqi_source_observation_count: eaqiInputValue === null
        ? null
        : toSafeWholeNumber(hourlySampleCount),
      eaqi_required_observation_count: 1,
      eaqi_calculation_status: eaqiStatus,
      eaqi_missing_reason: eaqiStatus === "ok" ? null : eaqiStatus,
      hourly_mean_ugm3: hourlyMean,
      rolling24h_mean_ugm3: rolling24hMean,
      hourly_sample_count: hourlySampleCount,
      daqi_index_level: daqiIndexLevel,
      eaqi_index_level: eaqiIndexLevel,
      no2_hourly_mean_ugm3: pollutant === "no2" ? hourlyMean : null,
      pm25_hourly_mean_ugm3: pollutant === "pm25" ? hourlyMean : null,
      pm10_hourly_mean_ugm3: pollutant === "pm10" ? hourlyMean : null,
      pm25_rolling24h_mean_ugm3: pollutant === "pm25" ? rolling24hMean : null,
      pm10_rolling24h_mean_ugm3: pollutant === "pm10" ? rolling24hMean : null,
      daqi_no2_index_level: pollutant === "no2" ? daqiIndexLevel : null,
      daqi_pm25_rolling24h_index_level: pollutant === "pm25" ? daqiIndexLevel : null,
      daqi_pm10_rolling24h_index_level: pollutant === "pm10" ? daqiIndexLevel : null,
      eaqi_no2_index_level: pollutant === "no2" ? eaqiIndexLevel : null,
      eaqi_pm25_index_level: pollutant === "pm25" ? eaqiIndexLevel : null,
      eaqi_pm10_index_level: pollutant === "pm10" ? eaqiIndexLevel : null,
      algorithm_version: "aqilevels_hourly_v1",
      computed_at_utc: null,
      updated_at: null,
    });
  }
  return rows;
}

function parseParquetKeysFromManifestRecord(
  manifestRecord: Record<string, unknown>,
): string[] {
  const keys = new Set<string>();
  const parquetObjectKeys = Array.isArray(manifestRecord.parquet_object_keys)
    ? manifestRecord.parquet_object_keys
    : [];
  for (const keyRaw of parquetObjectKeys) {
    const key = String(keyRaw || "").trim();
    if (key) {
      keys.add(key);
    }
  }
  const files = Array.isArray(manifestRecord.files) ? manifestRecord.files : [];
  for (const fileRaw of files) {
    if (!fileRaw || typeof fileRaw !== "object" || Array.isArray(fileRaw)) {
      continue;
    }
    const key = String((fileRaw as Record<string, unknown>).key || "").trim();
    if (key) {
      keys.add(key);
    }
  }
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

async function loadObsRowsForConnectorDayFromLocalHistory(
  dayUtc: string,
  connectorId: number,
): Promise<ObsHistoryRow[] | null> {
  const manifestKey = buildObsConnectorManifestKey(dayUtc, connectorId);
  const manifestBytes = loadLocalHistoryObjectBytesByR2Key(manifestKey);
  if (!manifestBytes) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error(`Invalid local observation manifest JSON: ${manifestKey}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid local observation manifest object: ${manifestKey}`);
  }
  const parquetKeys = parseParquetKeysFromManifestRecord(
    parsed as Record<string, unknown>,
  );
  const rows: ObsHistoryRow[] = [];
  for (const parquetKey of parquetKeys) {
    const parquetBytes = loadLocalHistoryObjectBytesByR2Key(parquetKey);
    if (!parquetBytes) {
      throw new Error(
        `source_to_r2_merge_authoritative_local_parquet_missing: day_utc=${dayUtc} connector_id=${connectorId} key=${parquetKey}`,
      );
    }
    const parsedRows = await readObsHistoryRowsFromParquetBytes(parquetBytes);
    appendRowsSafe(rows, parsedRows);
  }
  return rows;
}

async function loadAqiRowsForConnectorDayFromLocalHistory(
  dayUtc: string,
  connectorId: number,
): Promise<AqilevelsHistoryRow[] | null> {
  const manifestKey = buildAqiConnectorManifestKey(dayUtc, connectorId);
  const manifestBytes = loadLocalHistoryObjectBytesByR2Key(manifestKey);
  if (!manifestBytes) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error(`Invalid local AQI manifest JSON: ${manifestKey}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid local AQI manifest object: ${manifestKey}`);
  }
  const parquetKeys = parseParquetKeysFromManifestRecord(
    parsed as Record<string, unknown>,
  );
  const rows: AqilevelsHistoryRow[] = [];
  for (const parquetKey of parquetKeys) {
    const parquetBytes = loadLocalHistoryObjectBytesByR2Key(parquetKey);
    if (!parquetBytes) {
      logStructured("warning", "source_to_r2_merge_local_aqi_parquet_missing", {
        day_utc: dayUtc,
        connector_id: connectorId,
        parquet_key: parquetKey,
      });
      continue;
    }
    const parsedRows = await readAqiHistoryRowsFromParquetBytes(parquetBytes);
    for (const row of parsedRows) {
      rows.push({ ...row, connector_id: connectorId });
    }
  }
  return rows;
}

function dedupeObsHistoryRows(rows: ObsHistoryRow[]): ObsHistoryRow[] {
  const byKey = new Map<string, ObsHistoryRow>();
  for (const row of rows) {
    const key = `${row.timeseries_id}|${row.observed_at}`;
    byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.observed_at < right.observed_at) return -1;
    if (left.observed_at > right.observed_at) return 1;
    return 0;
  });
}

function appendRowsSafe<T>(
  target: T[],
  source: Iterable<T> | null | undefined,
): void {
  if (!source) {
    return;
  }
  for (const row of source) {
    target.push(row);
  }
}

function dedupeAqiHistoryRows(
  rows: AqilevelsHistoryRow[],
): AqilevelsHistoryRow[] {
  const byKey = new Map<string, AqilevelsHistoryRow>();
  for (const row of rows) {
    const key =
      `${row.timeseries_id}|${row.pollutant_code}|${row.timestamp_hour_utc}`;
    byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort((left, right) => {
    if (left.timeseries_id !== right.timeseries_id) {
      return left.timeseries_id - right.timeseries_id;
    }
    if (left.pollutant_code < right.pollutant_code) return -1;
    if (left.pollutant_code > right.pollutant_code) return 1;
    if (left.timestamp_hour_utc < right.timestamp_hour_utc) return -1;
    if (left.timestamp_hour_utc > right.timestamp_hour_utc) return 1;
    return 0;
  });
}

async function fetchSourceObservationRowsForConnectorFromR2ObservationHistory(
  connectorId: number,
  lookbackStartIso: string,
  dayEndIso: string,
): Promise<{ rows: SourceObservationRow[]; source_filter: string }> {
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
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
        object = await loadHistoryObjectBytesByR2Key(parquetKey);
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
      const observedAtColumn = schemaColumns.includes("observed_at_utc")
        ? "observed_at_utc"
        : "observed_at";
      if (
        timeseriesStatsIndex < 0 || !schemaColumns.includes(observedAtColumn) ||
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
                observedAtColumn,
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
            connectorId,
          });
          if (mappedRows.length > 0) {
            const filteredRows = requestedStationIdSet
              ? mappedRows.filter((row) =>
                requestedStationIdSet.has(row.station_id)
              )
              : mappedRows;
            if (filteredRows.length > 0) {
              appendRowsSafe(mappedRowsRaw, filteredRows);
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
      ? (INTEGRITY_PROPOSAL_MODE ? "combined_local_observations_station_filter" : "r2_observations_history_station_filter")
      : (INTEGRITY_PROPOSAL_MODE ? "combined_local_observations" : "r2_observations_history"),
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
      part_max_rows: OBS_R2_PART_MAX_ROWS,
      row_group_size: OBS_R2_ROW_GROUP_SIZE,
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
      part_max_rows: AQI_R2_PART_MAX_ROWS,
      row_group_size: AQI_R2_ROW_GROUP_SIZE,
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
  if (!R2_HISTORY_DROPBOX_ROOT && !hasRequiredR2Config(OBS_R2_CONFIG)) {
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
  const allowConnectorScopedV2AqiRefresh = HISTORY_R2_WRITE_VERSION === "v2" &&
    hasConnectorFilter;
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
    const debugDayManifestKey = buildAqiDebugDayManifestKey(dayUtc);
    const localDayManifest = loadLocalHistoryObjectBytesByR2Key(dayManifestKey);
    const dayManifestHead = INTEGRITY_PROPOSAL_MODE
      ? { exists: Boolean(localDayManifest) }
      : await r2HeadObject({ r2: OBS_R2_CONFIG, key: dayManifestKey });
    const hadExistingDayManifest = dayManifestHead.exists;
    const targetConnectorSet = new Set(targetConnectors);
    const nonTargetConnectors = observedConnectorIds.filter((connectorId) =>
      !targetConnectorSet.has(connectorId)
    );
    const unresolvedNonTargetConnectors: number[] = [];
    if (hasConnectorFilter && !allowConnectorScopedV2AqiRefresh) {
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
      connector_scoped_v2_aqi_refresh: allowConnectorScopedV2AqiRefresh,
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
        ) as AqilevelsHistoryRow[];
        connectorRowsWritten = aqilevelRows.length;
        const generationDiagnostics = buildAqiGenerationDiagnostics(
          sourceFetch.rows,
          dayUtc,
          connectorRowsWritten,
        );
        logStructured(
          generationDiagnostics.reason ? "warning" : "info",
          "r2_history_obs_to_aqilevels_connector_diagnostics",
          {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_filter: sourceFetch.source_filter,
            diagnostic_reason: generationDiagnostics.reason,
            ...generationDiagnostics.counters,
          },
        );
        if (
          !DRY_RUN &&
          hasConnectorFilter &&
          connectorRowsRead > 0 &&
          connectorRowsWritten === 0
        ) {
          throw new Error(
            `explicit connector/day AQI rebuild produced no rows: ${
              generationDiagnostics.reason || "unknown_aqi_generation_zero_rows"
            }`,
          );
        }
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
            diagnostic_reason: generationDiagnostics.reason,
            diagnostic_counters: generationDiagnostics.counters,
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

        if (writePlan.delete_existing && !INTEGRITY_PROPOSAL_MODE) {
          if (!dayManifestRemovedCount && hadExistingDayManifest) {
            dayManifestRemovedCount = await deleteR2ObjectIfExists(
              dayManifestKey,
            );
            if (HISTORY_R2_WRITE_VERSION === "v2") {
              dayManifestRemovedCount += await deleteR2ObjectIfExists(
                debugDayManifestKey,
              );
            }
          }
          connectorObjectsDeleted = await deleteR2Prefix(
            buildAqiConnectorPrefix(dayUtc, connectorId),
          );
          if (HISTORY_R2_WRITE_VERSION === "v2") {
            connectorObjectsDeleted += await deleteR2Prefix(
              buildAqiDebugConnectorPrefix(dayUtc, connectorId),
            );
          }
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
            diagnostic_reason: generationDiagnostics.reason,
            diagnostic_counters: generationDiagnostics.counters,
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
          diagnostic_reason: null,
          diagnostic_counters: {},
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

    if (DRY_RUN || INTEGRITY_PROPOSAL_MODE) {
      if (INTEGRITY_PROPOSAL_MODE && !dayFailed) summary.exported_days.push(dayUtc);
      continue;
    }

    summary.objects_deleted_r2 += dayManifestRemovedCount;

    if (dayFailed) {
      summary.failed_days.push(dayUtc);
      for (const connectorId of touchedConnectorIds) {
        try {
          let deleted = await deleteR2Prefix(
            buildAqiConnectorPrefix(dayUtc, connectorId),
          );
          if (HISTORY_R2_WRITE_VERSION === "v2") {
            deleted += await deleteR2Prefix(
              buildAqiDebugConnectorPrefix(dayUtc, connectorId),
            );
          }
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
    const unresolvedNonTargetAfterRefresh =
      hasConnectorFilter && !allowConnectorScopedV2AqiRefresh
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

    if (HISTORY_R2_WRITE_VERSION === "v2") {
      const dataDayManifest = createAqiV2DayManifest({
        profile: "data",
        dayUtc,
        runId,
        manifestKey: dayManifestKey,
        connectorManifests,
        writerGitSha: OBS_R2_WRITER_GIT_SHA,
        backedUpAtUtc: nowIso(),
      });
      const debugConnectorManifests = await loadAllAqiConnectorManifestsForDayPrefix(
        dayUtc,
        AQI_R2_HISTORY_DEBUG_PREFIX_V2,
      );
      const debugDayManifest = createAqiV2DayManifest({
        profile: "debug",
        dayUtc,
        runId,
        manifestKey: debugDayManifestKey,
        connectorManifests: debugConnectorManifests,
        writerGitSha: OBS_R2_WRITER_GIT_SHA,
        backedUpAtUtc: nowIso(),
      });
      await r2PutObject({
        r2: OBS_R2_CONFIG,
        key: dayManifestKey,
        body: encodeJsonBody(dataDayManifest),
        content_type: "application/json",
      });
      await r2PutObject({
        r2: OBS_R2_CONFIG,
        key: debugDayManifestKey,
        body: encodeJsonBody(debugDayManifest),
        content_type: "application/json",
      });
      summary.objects_written_r2 += 2;
    } else {
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
      summary.objects_written_r2 += 1;
    }
    const manifestHead = await r2HeadObject({
      r2: OBS_R2_CONFIG,
      key: dayManifestKey,
    });
    if (!manifestHead.exists) {
      throw new Error(
        `Missing AQI day manifest after upload: ${dayManifestKey}`,
      );
    }
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
  const sourceObservationsOnly = BACKFILL_OUTPUT_SCOPE === "observations_only";
  if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
    if (!INTEGRITY_PROPOSAL_MODE || !INTEGRITY_PROPOSAL_FINALIZE || !sourceObservationsOnly ||
      !FORCE_REPLACE || REQUESTED_TIMESERIES_IDS?.length || CONNECTOR_IDS?.length !== 1) {
      throw new Error(
        "complete connector-day repair requires Integrity prepare/finalize, observations_only, force_replace, exactly one connector and no timeseries filter",
      );
    }
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

  if (SOS_SOURCE_ENABLED) {
    const resolvedSosConnectorId = await resolveConnectorIdByCode(
      SOS_CONNECTOR_CODE,
    );
    let sosConnectorId: number | null = null;
    if (resolvedSosConnectorId) {
      sosConnectorId = resolvedSosConnectorId;
    } else if (
      Number.isInteger(SOS_CONNECTOR_ID_FALLBACK) &&
      SOS_CONNECTOR_ID_FALLBACK > 0
    ) {
      sosConnectorId = SOS_CONNECTOR_ID_FALLBACK;
      warnings.push(
        `Could not resolve connector_code=${SOS_CONNECTOR_CODE}; using fallback connector_id=${SOS_CONNECTOR_ID_FALLBACK}.`,
      );
    } else {
      warnings.push(
        `UK-AIR SOS source adapter enabled, but connector_id could not be resolved from connector_code=${SOS_CONNECTOR_CODE}; skipping UK-AIR SOS source adapter.`,
      );
    }
    if (sosConnectorId) {
      sourceAdapterByConnectorId.set(sosConnectorId, "sos");
    }
  } else {
    warnings.push(
      "UK-AIR SOS source adapter is disabled by UK_AQ_BACKFILL_SOS_SOURCE_ENABLED=false.",
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
  const sensorcommunityArchiveIndexByDay = new Map<
    string,
    SensorcommunityArchiveIndexResult
  >();

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
      const sosRegistry = sourceAdapter === "sos"
        ? loadSosSourceLabelRegistrySnapshot()
        : null;

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
        const sourceFilesEnumerated: string[] = [];
        const sourceFilesRequired: string[] = [];
        const sourceFilesRead: string[] = [];
        const sourceFilesAuthoritativelyAbsent: string[] = [];
        const sourceFileIdentities = new Map<string, {
          source_file: string;
          sha256: string;
          bytes: number;
        }>();
        const recordSourceFileRead = (sourceFile: string, content: string) => {
          const sourceFileKey = String(sourceFile || "").trim();
          if (!sourceFileKey) {
            throw new Error("complete_connector_day_source_file_identity_missing");
          }
          const identity = {
            source_file: sourceFileKey,
            sha256: sha256Hex(content),
            bytes: Buffer.byteLength(content, "utf8"),
          };
          const prior = sourceFileIdentities.get(sourceFileKey);
          if (
            prior &&
            (prior.sha256 !== identity.sha256 || prior.bytes !== identity.bytes)
          ) {
            throw new Error(
              `complete_connector_day_source_file_content_changed file=${sourceFileKey}`,
            );
          }
          sourceFileIdentities.set(sourceFileKey, identity);
        };
        let sourceEnumerationComplete = false;
        let openaqFetchErrorCount = 0;
        let candidateSourceUnits = 0;

        if (sourceAdapter === "breathelondon") {
          if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
            throw new Error(
              "complete_connector_day_enumeration_not_proven adapter=breathelondon",
            );
          }
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
            appendRowsSafe(observationRowsRaw, parsed.rows);
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
          let archiveIndexResult = sensorcommunityArchiveIndexByDay.get(dayUtc) ||
            null;
          if (!archiveIndexResult) {
            archiveIndexResult = await fetchSensorcommunityArchiveFileNames(
              dayUtc,
            );
            sensorcommunityArchiveIndexByDay.set(dayUtc, archiveIndexResult);
          }
          const archiveFileNames = archiveIndexResult.file_names;
          sourceFilesEnumerated.push(...archiveFileNames.map((name) =>
            `${archiveIndexResult.index_url}#${name}`
          ));

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
          sourceFilesRequired.push(...candidateFiles.map((name) =>
            `${archiveIndexResult.index_url}#${name}`
          ));

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
            const shouldWriteScommEmptyManifest = archiveIndexResult.day_missing ||
              archiveFileNames.length === 0;
            sourceCheckpointJson.archive_index_url = archiveIndexResult.index_url;
            sourceCheckpointJson.archive_day_missing =
              archiveIndexResult.day_missing;
            sourceCheckpointJson.archive_file_count = archiveFileNames.length;
            sourceCheckpointJson.candidate_files = candidateFiles.length;
            sourceCheckpointJson.station_ref_count = lookup.station_refs.size;
            sourceCheckpointJson.requested_station_ref_count =
              requestedStationRefs?.size || null;
            if (shouldWriteScommEmptyManifest) {
              sourceCheckpointJson.no_data_classification =
                "authoritative_no_data";
              sourceCheckpointJson.fetch_outcomes = {
                found: candidateFiles.length,
                missing: archiveFileNames.length,
                error: 0,
              };
              sourceCheckpointJson.empty_manifest_written = true;
              sourceCheckpointJson.empty_manifest_reason =
                archiveIndexResult.day_missing
                  ? "no_archive_day_index"
                  : "no_matching_source_files";
              logStructured(
                "info",
                "source_to_r2_sensorcommunity_no_data_classification",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: sourceAdapter,
                  class: "authoritative_no_data",
                  fetch_outcomes: sourceCheckpointJson.fetch_outcomes,
                  reason: sourceCheckpointJson.empty_manifest_reason,
                },
              );
              logStructured(
                "info",
                "source_to_r2_sensorcommunity_empty_manifest_written",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: sourceAdapter,
                  reason: sourceCheckpointJson.empty_manifest_reason,
                },
              );
            } else {
              if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
                throw new Error(
                  `sensorcommunity_complete_enumeration_metadata_mismatch archive_files=${archiveFileNames.length} unknown_station_refs=${unknownStationRefs.size}`,
                );
              }
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
                  no_data_classification: "metadata_mismatch",
                  station_ref_count: lookup.station_refs.size,
                  requested_station_ref_count: requestedStationRefs?.size || null,
                  archive_file_count: archiveFileNames.length,
                },
                started_at: startedAt,
                finished_at: nowIso(),
              });
              continue;
            }
          }

          let totalSourceRecords = 0;
          let totalSkippedOutsideDay = 0;
          let totalSkippedNullValue = 0;
          for (const fileName of candidateFiles) {
            const csvText = await fetchSensorcommunityArchiveCsv(
              dayUtc,
              fileName,
            );
            const sourceFileIdentity = `${archiveIndexResult.index_url}#${fileName}`;
            sourceFilesRead.push(sourceFileIdentity);
            recordSourceFileRead(sourceFileIdentity, csvText);
            const parsed = parseSensorcommunityCsvObservations({
              dayUtc,
              csvText,
              lookup,
            });
            appendRowsSafe(observationRowsRaw, parsed.rows);
            totalSourceRecords += parsed.source_records;
            totalSkippedOutsideDay += parsed.skipped_outside_day;
            totalSkippedNullValue += parsed.skipped_null_value;
          }
          sourceEnumerationComplete = true;
          candidateSourceUnits = candidateFiles.length;
          sourceCheckpointJson.candidate_files = candidateFiles.length;
          sourceCheckpointJson.archive_file_count = archiveFileNames.length;
          sourceCheckpointJson.total_source_records = totalSourceRecords;
          sourceCheckpointJson.total_skipped_outside_day = totalSkippedOutsideDay;
          sourceCheckpointJson.total_skipped_null_value = totalSkippedNullValue;
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
            if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
              throw new Error("openaq_complete_enumeration_has_no_station_refs");
            }
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
          let candidateLocationIds = Array.from(locationIdSet).sort((
            left,
            right,
          ) => left - right);
          if (candidateLocationIds.length === 0) {
            if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
              throw new Error("openaq_complete_enumeration_has_no_numeric_location_ids");
            }
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
          if (REQUESTED_TIMESERIES_IDS && REQUESTED_TIMESERIES_IDS.length > 0) {
            const requestedSet = new Set(REQUESTED_TIMESERIES_IDS);
            const targetedTimeseriesIds = sortedUniquePositiveInts(
              Array.from(requestedSet).filter((timeseriesId) =>
                lookup.binding_by_timeseries_id.has(timeseriesId)
              ),
            );
            if (targetedTimeseriesIds.length === 0) {
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
                  skip_reason: "no_matching_requested_timeseries_ids",
                  no_data_classification: "metadata_mismatch",
                  requested_timeseries_ids: REQUESTED_TIMESERIES_IDS,
                },
                started_at: startedAt,
                finished_at: nowIso(),
              });
              continue;
            }
            const targetedStationRefs = new Set<string>();
            for (const timeseriesId of targetedTimeseriesIds) {
              const binding = lookup.binding_by_timeseries_id.get(timeseriesId);
              if (binding?.station_ref) {
                targetedStationRefs.add(binding.station_ref);
              }
            }
            const filteredLocationIds = candidateLocationIds.filter((locationId) =>
              targetedStationRefs.has(String(locationId))
            );
            sourceCheckpointJson.requested_timeseries_ids =
              targetedTimeseriesIds;
            sourceCheckpointJson.requested_timeseries_station_ref_count =
              targetedStationRefs.size;
            sourceCheckpointJson.candidate_location_count_unfiltered =
              candidateLocationIds.length;
            sourceCheckpointJson.candidate_location_count_filtered =
              filteredLocationIds.length;
            candidateLocationIds = filteredLocationIds;
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
                  skip_reason:
                    "no_matching_location_ids_after_timeseries_filter",
                  no_data_classification: "metadata_mismatch",
                  requested_timeseries_ids: targetedTimeseriesIds,
                  requested_timeseries_station_ref_count:
                    targetedStationRefs.size,
                },
                started_at: startedAt,
                finished_at: nowIso(),
              });
              continue;
            }
          }
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
          // fetchOpenaqArchiveCsvGz currently returns found:true/false or throws.
          // It does not currently return structured non-throwing error results.
          let locationFetchErrorCount = 0;

          for (const locationId of candidateLocationIds) {
            const archiveKey = buildOpenaqArchiveObjectKey(dayUtc, locationId);
            sourceFilesEnumerated.push(archiveKey);
            sourceFilesRequired.push(archiveKey);
            const sourceFile = await fetchOpenaqArchiveCsvGz(
              dayUtc,
              locationId,
            );
            if (!sourceFile.found || !sourceFile.csv_text) {
              locationFilesMissing += 1;
              sourceFilesAuthoritativelyAbsent.push(sourceFile.archive_key);
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
            sourceFilesRead.push(sourceFile.archive_key);
            recordSourceFileRead(sourceFile.archive_key, sourceFile.csv_text);
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
            appendRowsSafe(observationRowsRaw, parsed.rows);
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
            const noDataClassification = locationFetchErrorCount === 0
              ? "authoritative_no_data"
              : "transport_error";
            sourceCheckpointJson.no_data_classification = noDataClassification;
            sourceCheckpointJson.fetch_outcomes = {
              found: locationFilesFound,
              missing: locationFilesMissing,
              error: locationFetchErrorCount,
            };
            logStructured("info", "source_to_r2_openaq_no_data_classification", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: sourceAdapter,
              class: noDataClassification,
              fetch_outcomes: sourceCheckpointJson.fetch_outcomes,
              reason: "no_location_day_source_files",
            });
            sourceCheckpointJson.empty_manifest_written = true;
            sourceCheckpointJson.empty_manifest_reason =
              "no_location_day_source_files";
            logStructured("info", "source_to_r2_openaq_empty_manifest_written", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: sourceAdapter,
              reason: "no_location_day_source_files",
            });
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
          openaqFetchErrorCount = locationFetchErrorCount;
          sourceEnumerationComplete = true;
        } else if (sourceAdapter === "sos") {
          if (INTEGRITY_COMPLETE_CONNECTOR_DAY && connectorId !== SOS_CONNECTOR_ID_FALLBACK) {
            throw new Error(
              `sos_complete_enumeration_connector_identity_mismatch connector_id=${connectorId} expected=${SOS_CONNECTOR_ID_FALLBACK}`,
            );
          }
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
          if (candidateStationRefs.size === 0 && !INTEGRITY_COMPLETE_CONNECTOR_DAY) {
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

          const lookup = await fetchSosSourceLookupForConnector(
            connectorId,
            candidateStationRefs,
          );
          const candidateBindingsUnfiltered = Array.from(
            lookup.binding_by_timeseries_ref.values(),
          )
            .filter((binding) => candidateStationRefs.has(binding.station_ref))
            .filter((binding) =>
              INTEGRITY_POLLUTANT_SCOPED_REPAIR
                ? INTEGRITY_REPAIR_POLLUTANTS.has(binding.pollutant_code)
                : INTEGRITY_COMPLETE_CONNECTOR_DAY ||
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
          let candidateBindings = candidateBindingsUnfiltered;
          if (REQUESTED_TIMESERIES_IDS && REQUESTED_TIMESERIES_IDS.length > 0) {
            const requestedSet = new Set(REQUESTED_TIMESERIES_IDS);
            const targetedTimeseriesIds = sortedUniquePositiveInts(
              Array.from(requestedSet).filter((timeseriesId) =>
                lookup.binding_by_timeseries_id.has(timeseriesId)
              ),
            );
            if (targetedTimeseriesIds.length === 0) {
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
                  skip_reason: "no_matching_requested_timeseries_ids",
                  no_data_classification: "metadata_mismatch",
                  requested_timeseries_ids: REQUESTED_TIMESERIES_IDS,
                },
                started_at: startedAt,
                finished_at: nowIso(),
              });
              continue;
            }
            const targetedSet = new Set(targetedTimeseriesIds);
            candidateBindings = candidateBindingsUnfiltered.filter((binding) =>
              targetedSet.has(binding.timeseries_id)
            );
            sourceCheckpointJson.requested_timeseries_ids = targetedTimeseriesIds;
            sourceCheckpointJson.candidate_timeseries_count_unfiltered =
              candidateBindingsUnfiltered.length;
            sourceCheckpointJson.candidate_timeseries_count_filtered =
              candidateBindings.length;
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
                  skip_reason:
                    "no_matching_timeseries_bindings_after_timeseries_filter",
                  no_data_classification: "metadata_mismatch",
                  requested_timeseries_ids: targetedTimeseriesIds,
                },
                started_at: startedAt,
                finished_at: nowIso(),
              });
              continue;
            }
          }

          if (candidateBindings.length === 0 && !INTEGRITY_COMPLETE_CONNECTOR_DAY) {
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

          const validFlatFileMappings =
            await assertSosFlatFileMappingsForBackfill({
              connector_id: connectorId,
              day_utc: dayUtc,
              bindings: candidateBindings,
            });
          if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
            candidateBindings = validFlatFileMappings.map((mapping) => ({
              timeseries_id: mapping.timeseries_id,
              station_id: mapping.station_id,
              station_ref: String(mapping.station_ref || mapping.site_ref),
              timeseries_ref: String(mapping.timeseries_ref || mapping.timeseries_id),
              pollutant_code: mapping.pollutant_code,
            }));
          }
          const observedPropertyMappings =
            await loadR2CoreObservedPropertyMappings();

          if (!SOS_FLAT_FILE_ROOT) {
            throw new Error(
              "UK_AQ_BACKFILL_SOS_FLAT_FILE_ROOT is required for SOS historical repair",
            );
          }
          const sourceBaseUrl = SOS_FLAT_FILE_ROOT;
          const dayStartIso = utcDayStartIso(dayUtc);
          const dayEndIso = utcDayEndIso(dayUtc);
          const timespan = `${dayStartIso}/${dayEndIso}`;
          let knownNoDataTimeseriesEntries =
            new Map<string, SosNoDataManifestEntry>();
          try {
            knownNoDataTimeseriesEntries = readSosNoDataManifest(dayUtc);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logStructured(
              "warning",
              "source_to_r2_sos_no_data_manifest_read_failed",
              {
                run_id: runId,
                day_utc: dayUtc,
                connector_id: connectorId,
                source_adapter: "sos",
                error: message,
              },
            );
          }
          const knownNoDataTimeseriesRefs = new Set(
            knownNoDataTimeseriesEntries.keys(),
          );

          const flatFileRows: SourceObservationRow[] = [];
          const flatFileSiteRefs = Array.from(
            new Set(validFlatFileMappings.map((row) => row.site_ref.toUpperCase())),
          ).sort();
          let flatFileSourceRecords = 0;
          let flatFileSkippedOtherDays = 0;
          let flatFileSkippedInvalidRows = 0;
          let flatFileSkippedUnselectedPollutantRows = 0;
          let flatFileBlockedTargetDayRows = 0;
          const flatFileSourceLabelClassifications: Array<Record<string, unknown>> = [];
          const flatFileBlockedTargetDayRowSamples: Record<string, unknown>[] = [];
          const flatFileUnits = new Set<string>();
          for (const siteRef of flatFileSiteRefs) {
            const csvPath = ukAirFlatFilePath(
              SOS_FLAT_FILE_ROOT,
              siteRef,
              Number(dayUtc.slice(0, 4)),
            );
            sourceFilesEnumerated.push(csvPath);
            sourceFilesRequired.push(csvPath);
            if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size <= 0) {
              throw new Error(`UK-AIR annual CSV cache is missing or empty: ${csvPath}`);
            }
            const csvText = fs.readFileSync(csvPath, "utf8");
            sourceFilesRead.push(csvPath);
            recordSourceFileRead(csvPath, csvText);
            const parsed = parseUkAirFlatFileObservations({
              dayUtc,
              siteRef,
              csvText,
              mappings: validFlatFileMappings,
              propertyMappings: observedPropertyMappings,
            });
            appendRowsSafe(flatFileRows, parsed.rows);
            flatFileSourceRecords += parsed.source_records;
            flatFileSkippedOtherDays += parsed.skipped_other_days;
            flatFileSkippedInvalidRows += parsed.skipped_invalid_rows;
            flatFileSkippedUnselectedPollutantRows +=
              parsed.skipped_unselected_pollutant_rows;
            flatFileSourceLabelClassifications.push(
              ...parsed.source_label_classifications,
            );
            flatFileBlockedTargetDayRows += parsed.blocked_target_day_rows;
            for (const sample of parsed.blocked_target_day_row_samples) {
              if (
                flatFileBlockedTargetDayRowSamples.length >=
                  INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT
              ) {
                break;
              }
              flatFileBlockedTargetDayRowSamples.push(sample);
            }
            parsed.units.forEach((unit) => flatFileUnits.add(unit));
          }
          const sourceLabelClassificationSummary = new Map<string, {
            classification: string;
            normalised_source_label: string;
            raw_label_variants: Set<string>;
            site_refs: Set<string>;
            observed_units: Set<string>;
            target_day_non_null_row_count: number;
            target_day_blank_unit_row_count: number;
            section_unit_evidence: Map<string, Record<string, unknown>>;
            possible_supported_pollutant_label: boolean;
          }>();
          for (const entry of flatFileSourceLabelClassifications) {
            const classification = String(entry.classification || "");
            const normalised = String(entry.normalised_source_label || "");
            const key = `${classification}|${normalised}`;
            const summary = sourceLabelClassificationSummary.get(key) || {
              classification,
              normalised_source_label: normalised,
              raw_label_variants: new Set<string>(),
              site_refs: new Set<string>(),
              observed_units: new Set<string>(),
              target_day_non_null_row_count: 0,
              target_day_blank_unit_row_count: 0,
              section_unit_evidence: new Map<string, Record<string, unknown>>(),
              possible_supported_pollutant_label: false,
            };
            if (entry.source_label) summary.raw_label_variants.add(String(entry.source_label));
            if (entry.site_ref) summary.site_refs.add(String(entry.site_ref));
            for (const unit of Array.isArray(entry.observed_units) ? entry.observed_units : []) {
              summary.observed_units.add(String(unit));
            }
            summary.target_day_non_null_row_count += Number(entry.target_day_non_null_row_count || 0);
            summary.target_day_blank_unit_row_count += Number(entry.target_day_blank_unit_row_count || 0);
            if (entry.header_section_index !== undefined) {
              const section = {
                site_ref: String(entry.site_ref || ""),
                header_section_index: Number(entry.header_section_index),
                target_day_non_null_row_count: Number(entry.target_day_non_null_row_count || 0),
                target_day_blank_unit_row_count: Number(entry.target_day_blank_unit_row_count || 0),
                section_non_empty_units: Array.isArray(entry.observed_units) ? entry.observed_units : [],
                section_normalised_units: Array.isArray(entry.section_normalised_units) ? entry.section_normalised_units : [],
                expected_unit: entry.expected_unit || null,
                expected_normalised_unit: entry.expected_normalised_unit || null,
              };
              summary.section_unit_evidence.set(`${section.site_ref}|${section.header_section_index}`, section);
            }
            summary.possible_supported_pollutant_label ||= Boolean(entry.possible_supported_pollutant_label);
            sourceLabelClassificationSummary.set(key, summary);
          }
          const sourceLabelClassifications = Array.from(sourceLabelClassificationSummary.values())
            .map((entry) => ({
              classification: entry.classification,
              normalised_source_label: entry.normalised_source_label,
              raw_label_variants: Array.from(entry.raw_label_variants).sort(),
              site_count: entry.site_refs.size,
              site_refs: Array.from(entry.site_refs).sort().slice(0, INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT),
              observed_units: Array.from(entry.observed_units).sort(),
              target_day_non_null_row_count: entry.target_day_non_null_row_count,
              target_day_blank_unit_row_count: entry.target_day_blank_unit_row_count,
              section_unit_evidence: Array.from(entry.section_unit_evidence.values()),
              possible_supported_pollutant_label: entry.possible_supported_pollutant_label,
            }))
            .sort((left, right) => `${left.classification}|${left.normalised_source_label}`.localeCompare(`${right.classification}|${right.normalised_source_label}`));
          const sourceLabelClassificationCounts = Object.fromEntries(
            ["mapped_selected", "mapped_out_of_scope", "ignore", "review", "unregistered"].map((classification) => [
              classification,
              sourceLabelClassifications.filter((entry) => entry.classification === classification).length,
            ]),
          );
          const sourceLabelTargetDayRowCounts = Object.fromEntries(
            ["mapped_selected", "mapped_out_of_scope", "ignore", "review", "unregistered"].map((classification) => [
              classification,
              sourceLabelClassifications
                .filter((entry) => entry.classification === classification)
                .reduce((total, entry) => total + Number(entry.target_day_non_null_row_count || 0), 0),
            ]),
          );
          const sourceLabelSummary = {
            mapped_selected_label_count: sourceLabelClassificationCounts.mapped_selected,
            mapped_selected_target_day_row_count: sourceLabelTargetDayRowCounts.mapped_selected,
            mapped_out_of_scope_label_count: sourceLabelClassificationCounts.mapped_out_of_scope,
            mapped_out_of_scope_target_day_row_count: sourceLabelTargetDayRowCounts.mapped_out_of_scope,
            known_ignored_source_label_count: sourceLabelClassificationCounts.ignore,
            known_ignored_target_day_row_count: sourceLabelTargetDayRowCounts.ignore,
            review_source_label_count: sourceLabelClassificationCounts.review,
            review_target_day_row_count: sourceLabelTargetDayRowCounts.review,
            unregistered_source_label_count: sourceLabelClassificationCounts.unregistered,
            unregistered_target_day_row_count: sourceLabelTargetDayRowCounts.unregistered,
          };
          const reviewSourceLabels = sourceLabelClassifications.filter((entry) =>
            entry.classification === "review" || entry.classification === "unregistered"
          );
          if (reviewSourceLabels.length) {
            logStructured("warning", "source_to_r2_sos_source_labels_require_review", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: "sos",
              review_source_label_count: reviewSourceLabels.length,
              review_target_day_row_count: reviewSourceLabels.reduce(
                (total, entry) => total + Number(entry.target_day_non_null_row_count || 0),
                0,
              ),
              samples: reviewSourceLabels.slice(0, INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT),
            });
          }
          const flatRowsByTimeseries = new Map<number, SourceObservationRow[]>();
          for (const row of flatFileRows) {
            const rows = flatRowsByTimeseries.get(row.timeseries_id) || [];
            rows.push(row);
            flatRowsByTimeseries.set(row.timeseries_id, rows);
          }
          const timeseriesResults: SosTimeseriesProcessResult[] = candidateBindings.map(
            (binding) => {
              const rows = flatRowsByTimeseries.get(binding.timeseries_id) || [];
              return {
                binding,
                station_ref: binding.station_ref,
                timeseries_ref: binding.timeseries_ref,
                rows,
                raw_point_count: rows.length,
                mapped_point_count: rows.length,
                mirror_reused: true,
                mirror_written: false,
                integrity_snapshot_reused: false,
                no_data_manifest_reused: false,
                empty_payload_confirmed: rows.length === 0,
                skipped_outside_day: 0,
                skipped_null_value: 0,
                error_message: null,
              };
            },
          );
          logStructured("info", "source_to_r2_sos_flat_file_parsed", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: "sos",
            source_kind: "uk_air_flat_file",
            site_ref_count: flatFileSiteRefs.length,
            source_records: flatFileSourceRecords,
            mapped_records: flatFileRows.length,
            skipped_other_days: flatFileSkippedOtherDays,
            skipped_invalid_rows: flatFileSkippedInvalidRows,
            skipped_unselected_pollutant_rows:
              flatFileSkippedUnselectedPollutantRows,
            source_label_classifications: sourceLabelClassifications,
            source_label_summary: sourceLabelSummary,
            units: Array.from(flatFileUnits).sort(),
          });
          let totalRawPoints = 0;
          let totalMappedPoints = 0;
          let totalMirrorReused = 0;
          let totalMirrorWritten = 0;
          let totalIntegritySnapshotReused = 0;
          let totalNoDataManifestReused = 0;
          let totalSkippedOutsideDay = 0;
          let totalSkippedNullValue = 0;
          const failedTimeseries: string[] = [];
          for (const result of timeseriesResults) {
            appendRowsSafe(observationRowsRaw, result.rows);
            totalRawPoints += result.raw_point_count;
            totalMappedPoints += result.mapped_point_count;
            totalMirrorReused += result.mirror_reused ? 1 : 0;
            totalMirrorWritten += result.mirror_written ? 1 : 0;
            totalIntegritySnapshotReused += result.integrity_snapshot_reused
              ? 1
              : 0;
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
              writeSosNoDataManifest({
                day_utc: dayUtc,
                entries: knownNoDataTimeseriesEntries,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logStructured(
                "warning",
                "source_to_r2_sos_no_data_manifest_write_failed",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: "sos",
                  error: message,
                },
              );
            }
          }

          if (failedTimeseries.length > 0) {
            throw new Error(
              `sos_timeseries_fetch_failed: ${failedTimeseries.length} timeseries failed: ${
                failedTimeseries.slice(0, 5).join(" | ")
              }`,
            );
          }

          candidateSourceUnits = candidateBindings.length;
          sourceCheckpointJson.source_base_url = sourceBaseUrl;
          sourceCheckpointJson.source_kind = "uk_air_flat_file";
          sourceCheckpointJson.time_basis = "GMT hour ending";
          sourceCheckpointJson.timespan = timespan;
          sourceCheckpointJson.flat_file_mapping_required = true;
          sourceCheckpointJson.flat_file_mapping_valid_rows =
            validFlatFileMappings.length;
          sourceCheckpointJson.flat_file_mapping_site_refs = Array.from(
            new Set(validFlatFileMappings.map((row) => row.site_ref)),
          ).sort();
          sourceCheckpointJson.candidate_station_ref_count =
            candidateStationRefs.size;
          sourceCheckpointJson.candidate_timeseries_count =
            candidateBindings.length;
          sourceCheckpointJson.mirror_reused_count = totalMirrorReused;
          sourceCheckpointJson.mirror_written_count = totalMirrorWritten;
          sourceCheckpointJson.integrity_snapshot_reused_count =
            totalIntegritySnapshotReused;
          sourceCheckpointJson.no_data_manifest_reused_count =
            totalNoDataManifestReused;
          sourceCheckpointJson.no_data_manifest_written_count =
            noDataManifestWrittenCount;
          sourceCheckpointJson.total_raw_points = totalRawPoints;
          sourceCheckpointJson.total_mapped_points = totalMappedPoints;
          sourceCheckpointJson.total_skipped_outside_day =
            totalSkippedOutsideDay;
          sourceCheckpointJson.total_skipped_null_value = totalSkippedNullValue;
          sourceCheckpointJson.total_skipped_invalid_rows =
            flatFileSkippedInvalidRows;
          sourceCheckpointJson.total_skipped_unselected_pollutant_rows =
            flatFileSkippedUnselectedPollutantRows;
          sourceCheckpointJson.sos_source_label_registry_file =
            sosRegistry?.source_file || null;
          sourceCheckpointJson.sos_source_label_registry_file_sha256 =
            sosRegistry?.file_sha256 || null;
          sourceCheckpointJson.sos_source_label_registry_content_sha256 =
            sosRegistry?.content_sha256 || null;
          sourceCheckpointJson.sos_source_label_classification_counts =
            sourceLabelClassificationCounts;
          sourceCheckpointJson.sos_source_label_target_day_row_counts =
            sourceLabelTargetDayRowCounts;
          sourceCheckpointJson.sos_source_label_summary = sourceLabelSummary;
          sourceCheckpointJson.sos_source_label_classifications =
            sourceLabelClassifications;
          sourceCheckpointJson.source_adapter_blocked_row_count =
            flatFileBlockedTargetDayRows;
          sourceCheckpointJson.source_adapter_blocked_row_samples =
            flatFileBlockedTargetDayRowSamples;
          sourceEnumerationComplete = true;
        } else {
          throw new Error(
            `unsupported source_to_r2 adapter=${sourceAdapter} for connector_id=${connectorId}`,
          );
        }

        const rowsForIntegrityBlockingEvidence = INTEGRITY_POLLUTANT_SCOPED_REPAIR
          ? observationRowsRaw.filter((row) =>
            INTEGRITY_REPAIR_POLLUTANTS.has(String(row.pollutant_code || "").toLowerCase())
          )
          : observationRowsRaw;
        const duplicateSourceEvidence = INTEGRITY_COMPLETE_CONNECTOR_DAY
          ? inspectIntegritySourceRowsForBlockingEvidence(
            rowsForIntegrityBlockingEvidence,
            connectorId,
          )
          : {
            canonical_observation_rows: [],
            duplicate_canonical_row_count: 0,
            duplicate_canonical_row_identity_samples: [],
            uncanonicalisable_source_row_count: 0,
            blocked_row_samples: [],
          };
        const completeCanonicalObservationRows = INTEGRITY_COMPLETE_CONNECTOR_DAY
          ? duplicateSourceEvidence.canonical_observation_rows
          : dedupeSourceObservationRows(observationRowsRaw);
        const canonicalObservationRows = INTEGRITY_POLLUTANT_SCOPED_REPAIR
          ? completeCanonicalObservationRows.filter((row) =>
            INTEGRITY_REPAIR_POLLUTANTS.has(String(row.pollutant_code || "").toLowerCase())
          )
          : completeCanonicalObservationRows;
        rowsRead += canonicalObservationRows.length;

        let obsHistoryRows = sourceObservationsToObsHistoryRows(
          canonicalObservationRows,
        );
        let aqilevelRows: AqilevelsHistoryRow[] = [];
        let integrityProposalActiveForConnectorDay =
          INTEGRITY_COMPLETE_CONNECTOR_DAY;

        if (INTEGRITY_COMPLETE_CONNECTOR_DAY) {
          if (!sourceEnumerationComplete) {
            throw new Error(
              `complete_connector_day_enumeration_not_proven adapter=${sourceAdapter}`,
            );
          }
          const dayStart = utcDayStartIso(dayUtc);
          const dayEnd = utcDayStartIso(shiftIsoDay(dayUtc, 1));
          const perTimeseries: Record<string, number> = {};
          const perPollutant: Record<string, number> = {};
          for (const row of obsHistoryRows) {
            if (!Number.isInteger(row.timeseries_id) || row.timeseries_id <= 0 ||
              !Number.isInteger(row.station_id) || Number(row.station_id) <= 0 ||
              !/^[a-z0-9_]+$/.test(String(row.pollutant_code || "")) ||
              !Number.isFinite(row.value) || row.observed_at < dayStart ||
              row.observed_at >= dayEnd) {
              throw new Error(
                `invalid_canonical_source_observation connector_id=${connectorId} row=${JSON.stringify(row)}`,
              );
            }
            const timeseriesKey = String(row.timeseries_id);
            const pollutantKey = String(row.pollutant_code);
            perTimeseries[timeseriesKey] = (perTimeseries[timeseriesKey] || 0) + 1;
            perPollutant[pollutantKey] = (perPollutant[pollutantKey] || 0) + 1;
          }
          const rowsJson = JSON.stringify(obsHistoryRows);
          const rowsPath = resolveIntegrityProposalStageFilePath(dayUtc, connectorId, "obs");
          const evidencePath = resolveIntegrityProposalEvidenceFilePath(dayUtc, connectorId);
          if (!rowsPath || !evidencePath) {
            throw new Error("Integrity source evidence path is unavailable");
          }
          writeIntegrityProposalStageJson(rowsPath, obsHistoryRows);
          const skippedRowCount = Object.entries(sourceCheckpointJson)
            .filter(([key, value]) => key.startsWith("total_skipped_") && Number.isFinite(Number(value)))
            .reduce((total, [, value]) => total + Number(value), 0);
          const reconciledSourceAdapterBlockedRows =
            reconcileIntegritySourceAdapterBlockedRows({
              raw: sourceCheckpointJson.source_adapter_blocked_row_count,
              scoped: INTEGRITY_POLLUTANT_SCOPED_REPAIR,
            });
          const sourceAdapterBlockedRowCount =
            reconciledSourceAdapterBlockedRows.selected;
          const outOfScopeSourceAdapterBlockedRowCount =
            reconciledSourceAdapterBlockedRows.outOfScope;
          const sourceAdapterBlockedRowSamples = Array.isArray(
            sourceCheckpointJson.source_adapter_blocked_row_samples,
          )
            ? sourceCheckpointJson.source_adapter_blocked_row_samples.filter(
              (sample): sample is Record<string, unknown> =>
                Boolean(sample) && typeof sample === "object" && !Array.isArray(sample),
            )
            : [];
          const blockedRowCount =
            duplicateSourceEvidence.duplicate_canonical_row_count +
            duplicateSourceEvidence.uncanonicalisable_source_row_count +
            reconciledSourceAdapterBlockedRows.blocking;
          const blockedRowSamples = [
            ...duplicateSourceEvidence.blocked_row_samples,
            ...sourceAdapterBlockedRowSamples,
          ].slice(0, INTEGRITY_SOURCE_EVIDENCE_SAMPLE_LIMIT);
          const sourceFileIdentityList = Array.from(sourceFileIdentities.values())
            .sort((left, right) => left.source_file.localeCompare(right.source_file));
          if (sourceFileIdentityList.length !== new Set(sourceFilesRead).size) {
            throw new Error(
              "complete_connector_day_source_file_identity_count_mismatch",
            );
          }
          const sourceFileIdentitiesJson = JSON.stringify(sourceFileIdentityList);
          writeIntegrityProposalStageJson(evidencePath, {
            schema_version: 1,
            contract: INTEGRITY_POLLUTANT_SCOPED_REPAIR
              ? "pollutant_scoped_authoritative_connector_day_source_rows"
              : "complete_authoritative_connector_day_source_rows",
            requested_pollutant_set: INTEGRITY_POLLUTANT_SCOPED_REPAIR
              ? Array.from(INTEGRITY_REPAIR_POLLUTANTS).sort()
              : [],
            connector_id: connectorId,
            day_utc: dayUtc,
            source_adapter: sourceAdapter,
            enumeration_complete: true,
            files_enumerated: Array.from(new Set(sourceFilesEnumerated)).sort(),
            files_required: Array.from(new Set(sourceFilesRequired)).sort(),
            files_read: Array.from(new Set(sourceFilesRead)).sort(),
            files_authoritatively_absent: Array.from(
              new Set(sourceFilesAuthoritativelyAbsent),
            ).sort(),
            source_file_identities: sourceFileIdentityList,
            source_file_identities_sha256: sha256Hex(sourceFileIdentitiesJson),
            source_label_registry_snapshot_file:
              sourceCheckpointJson.sos_source_label_registry_file || null,
            source_label_registry_snapshot_file_sha256:
              sourceCheckpointJson.sos_source_label_registry_file_sha256 || null,
            source_label_registry_snapshot_content_sha256:
              sourceCheckpointJson.sos_source_label_registry_content_sha256 || null,
            source_label_classification_counts:
              sourceCheckpointJson.sos_source_label_classification_counts || {},
            source_label_target_day_row_counts:
              sourceCheckpointJson.sos_source_label_target_day_row_counts || {},
            source_label_summary:
              sourceCheckpointJson.sos_source_label_summary || {},
            source_label_classifications:
              sourceCheckpointJson.sos_source_label_classifications || [],
            canonical_rows_file: "obs_history_rows.json",
            canonical_rows_sha256: sha256Hex(rowsJson),
            canonical_rows_bytes: Buffer.byteLength(rowsJson, "utf8"),
            total_rows: obsHistoryRows.length,
            per_timeseries_counts: Object.fromEntries(
              Object.entries(perTimeseries).sort(([left], [right]) => Number(left) - Number(right)),
            ),
            per_pollutant_counts: Object.fromEntries(
              Object.entries(perPollutant).sort(([left], [right]) => left.localeCompare(right)),
            ),
            pollutant_set: Object.keys(perPollutant).sort(),
            source_rows_before_canonical_dedupe: observationRowsRaw.length,
            duplicate_rows_removed_by_canonical_normalisation:
              0,
            duplicate_canonical_row_count:
              duplicateSourceEvidence.duplicate_canonical_row_count,
            duplicate_canonical_row_identity_samples:
              duplicateSourceEvidence.duplicate_canonical_row_identity_samples,
            uncanonicalisable_source_row_count:
              duplicateSourceEvidence.uncanonicalisable_source_row_count,
            source_adapter_blocked_row_count: sourceAdapterBlockedRowCount,
            source_adapter_blocked_row_samples: sourceAdapterBlockedRowSamples,
            out_of_scope_source_adapter_blocked_row_count: outOfScopeSourceAdapterBlockedRowCount,
            blocked_row_count: blockedRowCount,
            blocked_row_samples: blockedRowSamples,
            skipped_row_count: skippedRowCount,
            inactive_identity_rows_skipped: 0,
          });
          sourceCheckpointJson.complete_connector_day = true;
          sourceCheckpointJson.integrity_repair_pollutants = Array.from(INTEGRITY_REPAIR_POLLUTANTS).sort();
          sourceCheckpointJson.source_evidence_path = evidencePath;
          sourceCheckpointJson.source_evidence_rows_sha256 = sha256Hex(rowsJson);
          if (blockedRowCount > 0) {
            throw new Error(
              "complete_connector_day_source_evidence_blocked " +
                `connector_id=${connectorId} day_utc=${dayUtc} ` +
                `blocked_row_count=${blockedRowCount}`,
            );
          }
          if (INTEGRITY_SOURCE_EVIDENCE_ONLY) {
            connectorDayComplete += 1;
            sourceProcessedDaySet.add(dayUtc);
            logStructured("info", "source_to_r2_connector_day_complete", {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: sourceAdapter,
              source_evidence_only: true,
              rows_observations: obsHistoryRows.length,
              pollutant_codes_written: Object.keys(perPollutant).sort(),
              objects_written_r2: 0,
            });
            continue;
          }
        }

        if (
          INTEGRITY_CHUNK_MERGE &&
          REQUESTED_TIMESERIES_IDS &&
          REQUESTED_TIMESERIES_IDS.length > 0
        ) {
          const connectorLookup = await fetchSourceLookupForConnector(connectorId);
          const requestedSet = new Set(REQUESTED_TIMESERIES_IDS);
          const targetedTimeseriesIds = sortedUniquePositiveInts(
            Array.from(requestedSet).filter((timeseriesId) =>
              connectorLookup.binding_by_timeseries_id.has(timeseriesId)
            ),
          );
          if (targetedTimeseriesIds.length > 0) {
            const targetedSet = new Set(targetedTimeseriesIds);
            const useIntegrityProposalStage = INTEGRITY_PROPOSAL_MODE && !DRY_RUN;
            const rawStageObsRows = useIntegrityProposalStage
              ? readObsRowsForConnectorDayFromIntegrityProposalStage(dayUtc, connectorId)
              : null;
            const rawLocalObsRows = rawStageObsRows ??
              (INTEGRITY_PROPOSAL_MODE ? [] : await loadObsRowsForConnectorDayFromLocalHistory(
                dayUtc, connectorId,
              ));
            const rawStageAqiRows = sourceObservationsOnly || !useIntegrityProposalStage
              ? null
              : readAqiRowsForConnectorDayFromIntegrityProposalStage(dayUtc, connectorId);
            const rawLocalAqiRows = sourceObservationsOnly
              ? null
              : rawStageAqiRows ?? await loadAqiRowsForConnectorDayFromLocalHistory(
                dayUtc,
                connectorId,
              );
            // When no local history exists for this (day, connector), there is
            // nothing to preserve — treat preservation as empty and write the
            // replacement rows as a fresh manifest. Covers integrity backfills
            // for days the original ingest missed (upstream outage, fresh
            // historical backfill, etc.).
            const localHistoryMissing = !rawLocalObsRows ||
              (!sourceObservationsOnly && !rawLocalAqiRows);
            const usingStagedBaseline = rawStageObsRows !== null ||
              (!sourceObservationsOnly && rawStageAqiRows !== null);
            if (localHistoryMissing && !usingStagedBaseline) {
              logStructured(
                "info",
                "source_to_r2_targeted_merge_no_local_history",
                {
                  run_id: runId,
                  day_utc: dayUtc,
                  connector_id: connectorId,
                  source_adapter: sourceAdapter,
                  obs_local_missing: !rawLocalObsRows,
                  aqi_local_missing: !sourceObservationsOnly && !rawLocalAqiRows,
                  targeted_timeseries_id_count: targetedTimeseriesIds.length,
                },
              );
            }
            if (useIntegrityProposalStage) {
              integrityProposalActiveForConnectorDay = true;
            }
            const localObsRows = rawLocalObsRows ?? [];
            const localAqiRows = rawLocalAqiRows;

            const replacementObsRows = obsHistoryRows.filter((row) =>
              targetedSet.has(row.timeseries_id)
            );
            const preservedObsRows = localObsRows.filter((row) =>
              !targetedSet.has(row.timeseries_id)
            );
            const mergedObsRows: ObsHistoryRow[] = [];
            appendRowsSafe(mergedObsRows, preservedObsRows);
            appendRowsSafe(mergedObsRows, replacementObsRows);
            obsHistoryRows = dedupeObsHistoryRows(mergedObsRows);

            sourceCheckpointJson.targeted_merge = true;
            sourceCheckpointJson.targeted_timeseries_ids = targetedTimeseriesIds;
            sourceCheckpointJson.targeted_replacement_obs_rows =
              replacementObsRows.length;
            sourceCheckpointJson.targeted_preserved_obs_rows =
              preservedObsRows.length;
            sourceCheckpointJson.targeted_local_history_missing =
              localHistoryMissing;
            sourceCheckpointJson.integrity_proposal_enabled = useIntegrityProposalStage;
            sourceCheckpointJson.integrity_proposal_finalize = useIntegrityProposalStage &&
              INTEGRITY_PROPOSAL_FINALIZE;
            sourceCheckpointJson.integrity_proposal_baseline = usingStagedBaseline
              ? "stage"
              : "local_history";
            if (!sourceObservationsOnly) {
              const effectiveLocalAqiRows = localAqiRows ?? [];
              const mergedSourceRows = mapR2ObservationRowsToSourceObservations({
                rows: obsHistoryRows.map((row) => ({
                  timeseries_id: row.timeseries_id,
                  observed_at: row.observed_at,
                  value: row.value,
                })),
                bindingByTimeseriesId: connectorLookup.binding_by_timeseries_id,
                windowStartIso: utcDayStartIso(dayUtc),
                windowEndIso: utcDayStartIso(shiftIsoDay(dayUtc, 1)),
                connectorId,
              });
              const replacementAqiRows = helperRowsToAqilevelHistoryRows(
                sourceObservationRowsToHelperRowsForDay(
                  mergedSourceRows.filter((row) =>
                    targetedSet.has(row.timeseries_id)
                  ),
                  dayUtc,
                ),
              );
              const preservedAqiRows = effectiveLocalAqiRows.filter((row) =>
                !targetedSet.has(row.timeseries_id)
              );
              const mergedAqiRows: AqilevelsHistoryRow[] = [];
              appendRowsSafe(mergedAqiRows, preservedAqiRows);
              appendRowsSafe(mergedAqiRows, replacementAqiRows);
              aqilevelRows = dedupeAqiHistoryRows(mergedAqiRows).map((row) => ({
                ...row,
                connector_id: connectorId,
              }));
              sourceCheckpointJson.targeted_replacement_aqi_rows =
                replacementAqiRows.length;
              sourceCheckpointJson.targeted_preserved_aqi_rows =
                preservedAqiRows.length;
            }
            if (useIntegrityProposalStage) {
              const obsStagePath = resolveIntegrityProposalStageFilePath(
                dayUtc,
                connectorId,
                "obs",
              );
              if (obsStagePath) {
                writeIntegrityProposalStageJson(obsStagePath, obsHistoryRows);
              }
              if (!sourceObservationsOnly) {
                const aqiStagePath = resolveIntegrityProposalStageFilePath(
                  dayUtc,
                  connectorId,
                  "aqi",
                );
                if (aqiStagePath) {
                  writeIntegrityProposalStageJson(aqiStagePath, aqilevelRows);
                }
              }
              sourceCheckpointJson.integrity_chunk_timeseries_ids = targetedTimeseriesIds;
              sourceCheckpointJson.integrity_staged_row_count = obsHistoryRows.length;
              sourceCheckpointJson.integrity_staged_rows_sha256 = sha256Hex(JSON.stringify(obsHistoryRows));
            }
          } else {
            if (!sourceObservationsOnly) {
              const helperRows = sourceObservationRowsToHelperRowsForDay(
                canonicalObservationRows,
                dayUtc,
              );
              aqilevelRows = helperRowsToAqilevelHistoryRows(helperRows);
            }
          }
        } else {
          if (!sourceObservationsOnly) {
            const helperRows = sourceObservationRowsToHelperRowsForDay(
              canonicalObservationRows,
              dayUtc,
            );
            aqilevelRows = helperRowsToAqilevelHistoryRows(helperRows);
          }
        }
        rowsWrittenAqilevels += aqilevelRows.length;

        const noObservations = obsHistoryRows.length === 0;
        const noAqilevels = aqilevelRows.length === 0;
        if (noObservations || (!sourceObservationsOnly && noAqilevels)) {
          const skipReason = noObservations
            ? "no_observation_rows"
            : "no_observations_or_aqilevel_rows";
          const shouldWriteOpenaqEmptyManifest = sourceAdapter === "openaq" &&
            noObservations &&
            sourceCheckpointJson.no_data_classification !== "transport_error";
          const shouldWriteSensorcommunityEmptyManifest =
            sourceAdapter === "sensorcommunity" &&
            noObservations &&
            sourceCheckpointJson.no_data_classification ===
              "authoritative_no_data";
          if (shouldWriteOpenaqEmptyManifest || shouldWriteSensorcommunityEmptyManifest) {
            sourceCheckpointJson.no_data_classification = "authoritative_no_data";
            if (shouldWriteOpenaqEmptyManifest) {
              sourceCheckpointJson.fetch_outcomes = sourceCheckpointJson.fetch_outcomes || {
                found: toSafeInt(sourceCheckpointJson.location_files_found),
                missing: toSafeInt(sourceCheckpointJson.location_files_missing),
                error: openaqFetchErrorCount,
              };
            } else {
              sourceCheckpointJson.fetch_outcomes = sourceCheckpointJson.fetch_outcomes || {
                found: toSafeInt(sourceCheckpointJson.candidate_files),
                missing: toSafeInt(sourceCheckpointJson.archive_file_count),
                error: 0,
              };
            }
            sourceCheckpointJson.empty_manifest_written = true;
            sourceCheckpointJson.empty_manifest_reason = skipReason;
            const noDataEventName = shouldWriteOpenaqEmptyManifest
              ? "source_to_r2_openaq_no_data_classification"
              : "source_to_r2_sensorcommunity_no_data_classification";
            const emptyManifestEventName = shouldWriteOpenaqEmptyManifest
              ? "source_to_r2_openaq_empty_manifest_written"
              : "source_to_r2_sensorcommunity_empty_manifest_written";
            logStructured("info", noDataEventName, {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: sourceAdapter,
              class: "authoritative_no_data",
              fetch_outcomes: sourceCheckpointJson.fetch_outcomes,
              reason: skipReason,
            });
            logStructured("info", emptyManifestEventName, {
              run_id: runId,
              day_utc: dayUtc,
              connector_id: connectorId,
              source_adapter: sourceAdapter,
              reason: skipReason,
            });
          } else {
            connectorDaySkipped += 1;
            logStructured("info", "source_to_r2_connector_day_skipped", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: sourceAdapter,
            skip_reason: skipReason,
            candidate_source_units: candidateSourceUnits,
            rows_observations: obsHistoryRows.length,
            rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
            targeted_merge: sourceCheckpointJson.targeted_merge ?? false,
            targeted_timeseries_id_count:
              Array.isArray(sourceCheckpointJson.targeted_timeseries_ids)
                ? sourceCheckpointJson.targeted_timeseries_ids.length
                : null,
            targeted_replacement_obs_rows:
              sourceCheckpointJson.targeted_replacement_obs_rows ?? null,
            targeted_preserved_obs_rows:
              sourceCheckpointJson.targeted_preserved_obs_rows ?? null,
            targeted_replacement_aqi_rows:
              sourceCheckpointJson.targeted_replacement_aqi_rows ?? null,
            targeted_preserved_aqi_rows:
              sourceCheckpointJson.targeted_preserved_aqi_rows ?? null,
          });
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
                skip_reason: skipReason,
                candidate_source_units: candidateSourceUnits,
                rows_observations: obsHistoryRows.length,
                rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
                ...sourceCheckpointJson,
              },
              started_at: startedAt,
              finished_at: nowIso(),
            });
            continue;
          }
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
            rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
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
              rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
              ...sourceCheckpointJson,
            },
            started_at: startedAt,
            finished_at: nowIso(),
          });
          sourceProcessedDaySet.add(dayUtc);
          continue;
        }

        if (
          integrityProposalActiveForConnectorDay &&
          !INTEGRITY_PROPOSAL_FINALIZE
        ) {
          connectorDayComplete += 1;
          sourceProcessedDaySet.add(dayUtc);
          logStructured("info", "source_to_r2_integrity_proposal_chunk_staged", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_adapter: sourceAdapter,
            rows_observations: obsHistoryRows.length,
            rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
          });
          await ledgerInsertRunDay(ledgerEnabled, {
            run_id: runId,
            run_mode: RUN_MODE,
            day_utc: dayUtc,
            connector_id: connectorId,
            source_kind: "download",
            status: "complete",
            rows_read: obsHistoryRows.length,
            rows_written_aqilevels: sourceObservationsOnly ? 0 : aqilevelRows.length,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              integrity_proposal_chunk_staged: true,
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
            rows_written_aqilevels: sourceObservationsOnly ? 0 : aqilevelRows.length,
            objects_written_r2: 0,
            checkpoint_json: {
              source_adapter: sourceAdapter,
              integrity_proposal_chunk_staged: true,
              updated_by_run_id: runId,
              completed_at: nowIso(),
              candidate_source_units: candidateSourceUnits,
              ...sourceCheckpointJson,
            },
            updated_at: nowIso(),
          });
          continue;
        }

        const obsExport = await exportObsConnectorRowsToR2({
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          rows: obsHistoryRows,
        });
        objectsWrittenR2 += obsExport.objects_written_r2;
        const integrityObservationProposalFinalisation =
          integrityProposalActiveForConnectorDay &&
          INTEGRITY_PROPOSAL_FINALIZE &&
          sourceObservationsOnly;
        let aqiExport:
          | { objects_written_r2: number; manifest_key: string }
          | null = null;

        if (!integrityObservationProposalFinalisation) {
          const obsConnectorManifests = await loadAllObsConnectorManifestsForDay(
            dayUtc,
          );
          if (!obsConnectorManifests.length) {
            throw new Error(
              `missing observation connector manifests for day=${dayUtc} after source_to_r2 export`,
            );
          }
          const obsDayManifest = createObsDayManifest({
            dayUtc,
            runId,
            connectorManifests: obsConnectorManifests,
            writerGitSha: OBS_R2_WRITER_GIT_SHA,
            backedUpAtUtc: nowIso(),
          });
        if (!sourceObservationsOnly) {
          aqiExport = await exportAqiConnectorRowsToR2({
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            rows: aqilevelRows,
          });
          objectsWrittenR2 += aqiExport.objects_written_r2;
          const aqiConnectorManifests = await loadAllAqiConnectorManifestsForDay(
            dayUtc,
          );
          if (!aqiConnectorManifests.length) {
            throw new Error(
              `missing AQI connector manifests for day=${dayUtc} after source_to_r2 export`,
            );
          }
          const aqiDayManifest = createAqiDayManifest({
            dayUtc,
            runId,
            connectorManifests: aqiConnectorManifests,
            writerGitSha: OBS_R2_WRITER_GIT_SHA,
            backedUpAtUtc: nowIso(),
          });
          await r2PutObject({
            r2: OBS_R2_CONFIG,
            key: buildAqiDayManifestKey(dayUtc),
            body: encodeJsonBody(aqiDayManifest),
            content_type: "application/json",
          });
          objectsWrittenR2 += 1;
        }
        await r2PutObject({
          r2: OBS_R2_CONFIG,
          key: buildObsDayManifestKey(dayUtc),
          body: encodeJsonBody(obsDayManifest),
          content_type: "application/json",
        });
        objectsWrittenR2 += 1;
        } else {
          logStructured("info", "canonical_local_proposal_built", {
            run_id: runId,
            day_utc: dayUtc,
            connector_id: connectorId,
            objects_written_r2: 0,
            objects_staged_local: obsExport.objects_staged_local ?? 0,
          });
        }
        if (
          integrityProposalActiveForConnectorDay &&
          INTEGRITY_PROPOSAL_FINALIZE &&
          INTEGRITY_PROPOSAL_CLEANUP
        ) {
          clearIntegrityProposalStageForConnectorDay(dayUtc, connectorId);
        }
        connectorDayComplete += 1;
        sourceProcessedDaySet.add(dayUtc);
        logStructured("info", "source_to_r2_connector_day_complete", {
          run_id: runId,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_adapter: sourceAdapter,
          candidate_source_units: candidateSourceUnits,
          rows_observations: obsHistoryRows.length,
          rows_with_missing_pollutant_code: obsExport.rows_with_missing_pollutant_code ?? 0,
          rows_skipped_missing_pollutant_code: obsExport.rows_skipped_missing_pollutant_code ?? 0,
          example_missing_pollutant_rows: obsExport.example_missing_pollutant_rows ?? [],
          pollutant_codes_written: obsExport.pollutant_codes_written ?? [],
          publication_state: integrityObservationProposalFinalisation
            ? "canonical_local_proposal_built"
            : "canonical_metadata_published",
          rows_aqilevels: sourceObservationsOnly ? null : aqilevelRows.length,
          objects_written_r2: sourceObservationsOnly
            ? obsExport.objects_written_r2 + (integrityObservationProposalFinalisation ? 0 : 1)
            : obsExport.objects_written_r2 +
              (aqiExport?.objects_written_r2 || 0) + 2,
        });

        await ledgerInsertRunDay(ledgerEnabled, {
          run_id: runId,
          run_mode: RUN_MODE,
          day_utc: dayUtc,
          connector_id: connectorId,
          source_kind: "download",
          status: "complete",
          rows_read: obsHistoryRows.length,
          rows_written_aqilevels: sourceObservationsOnly ? 0 : aqilevelRows.length,
          objects_written_r2: sourceObservationsOnly
            ? obsExport.objects_written_r2 + (integrityObservationProposalFinalisation ? 0 : 1)
            : obsExport.objects_written_r2 +
              (aqiExport?.objects_written_r2 || 0) + 2,
          checkpoint_json: {
            source_adapter: sourceAdapter,
            observation_manifest_key: obsExport.manifest_key,
            observation_manifest_owner: integrityObservationProposalFinalisation
              ? "integrity_local_proposal"
              : "writer",
            rows_with_missing_pollutant_code: obsExport.rows_with_missing_pollutant_code ?? 0,
            rows_skipped_missing_pollutant_code: obsExport.rows_skipped_missing_pollutant_code ?? 0,
            example_missing_pollutant_rows: obsExport.example_missing_pollutant_rows ?? [],
            pollutant_codes_written: obsExport.pollutant_codes_written ?? [],
            aqilevels_manifest_key: aqiExport?.manifest_key || null,
            day_observation_manifest_key: integrityObservationProposalFinalisation
              ? null : buildObsDayManifestKey(dayUtc),
            day_aqilevels_manifest_key: sourceObservationsOnly
              ? null
              : buildAqiDayManifestKey(dayUtc),
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
          rows_written_aqilevels: sourceObservationsOnly ? 0 : aqilevelRows.length,
          objects_written_r2: sourceObservationsOnly
            ? obsExport.objects_written_r2 + (integrityObservationProposalFinalisation ? 0 : 1)
            : obsExport.objects_written_r2 +
              (aqiExport?.objects_written_r2 || 0) + 2,
          checkpoint_json: {
            source_adapter: sourceAdapter,
            observation_manifest_key: obsExport.manifest_key,
            observation_manifest_owner: integrityObservationProposalFinalisation
              ? "integrity_local_proposal"
              : "writer",
            rows_with_missing_pollutant_code: obsExport.rows_with_missing_pollutant_code ?? 0,
            rows_skipped_missing_pollutant_code: obsExport.rows_skipped_missing_pollutant_code ?? 0,
            example_missing_pollutant_rows: obsExport.example_missing_pollutant_rows ?? [],
            pollutant_codes_written: obsExport.pollutant_codes_written ?? [],
            aqilevels_manifest_key: aqiExport?.manifest_key || null,
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
  validateRunModeOutputScope();
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
    output_scope: BACKFILL_OUTPUT_SCOPE,
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
    observations_part_max_rows: OBS_R2_PART_MAX_ROWS,
    observations_row_group_size: OBS_R2_ROW_GROUP_SIZE,
    aqilevels_part_max_rows: AQI_R2_PART_MAX_ROWS,
    aqilevels_row_group_size: AQI_R2_ROW_GROUP_SIZE,
    integrity_chunk_merge: INTEGRITY_CHUNK_MERGE,
    requested_timeseries_ids: REQUESTED_TIMESERIES_IDS,
    r2_history_dropbox_root: R2_HISTORY_DROPBOX_ROOT,
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
      output_scope: BACKFILL_OUTPUT_SCOPE,
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
    output_scope: BACKFILL_OUTPUT_SCOPE,
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
