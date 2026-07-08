import * as arrow from "npm:apache-arrow";
import * as parquetWasm from "npm:parquet-wasm/esm";

export type Who2021ParquetDataset =
  | "daily_status"
  | "rolling_year_status"
  | "calendar_year_status";

export type Who2021ParquetBatch = {
  dataset: Who2021ParquetDataset;
  object_key: string;
  row_count: number;
  rows_json: unknown;
};

const WRITER_VERSION = "uk-aq-who-2021-parquet-wasm-zstd-v1";
const DEFAULT_ROW_GROUP_SIZE = 50_000;
const VALID_OBJECT_KEY_RE =
  /^history\/v2\/who_2021\/(daily_status|rolling_year_status|calendar_year_status)\/.+\/part-\d{5}\.parquet$/;

let parquetWasmInitialized = false;
let writerProperties: unknown | null = null;

function ensureParquetWasmInitialized(): void {
  if (parquetWasmInitialized) return;
  const wasmUrl = import.meta.resolve(
    "npm:parquet-wasm/esm/parquet_wasm_bg.wasm",
  );
  const wasmBytes = Deno.readFileSync(new URL(wasmUrl));
  parquetWasm.initSync({ module: wasmBytes });
  parquetWasmInitialized = true;
}

function getWriterProperties(): unknown {
  if (writerProperties) return writerProperties;
  ensureParquetWasmInitialized();
  writerProperties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(DEFAULT_ROW_GROUP_SIZE)
    .setCreatedBy(WRITER_VERSION)
    .build();
  return writerProperties;
}

function asRows(rowsJson: unknown): Record<string, unknown>[] {
  if (Array.isArray(rowsJson)) {
    return rowsJson.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("WHO parquet rows_json must contain objects");
      }
      return row as Record<string, unknown>;
    });
  }
  if (typeof rowsJson === "string" && rowsJson.trim()) {
    return asRows(JSON.parse(rowsJson));
  }
  throw new Error("WHO parquet rows_json must be a JSON array");
}

function textVector(values: unknown[]) {
  return arrow.vectorFromArray(values.map(toNullableText), new arrow.Utf8());
}

function int32Vector(values: unknown[]) {
  return arrow.vectorFromArray(
    values.map(toNullableInteger),
    new arrow.Int32(),
  );
}

function float64Vector(values: unknown[]) {
  return arrow.vectorFromArray(
    values.map(toNullableNumber),
    new arrow.Float64(),
  );
}

function boolVector(values: unknown[]) {
  // parquet-wasm currently rejects explicit nullable Arrow Bool vectors with a
  // zero-length validity bitmap. Let Arrow infer the boolean column from the
  // nullable JS array so it builds the validity/data buffers correctly.
  return values.map(toNullableBoolean);
}

function dateVector(values: unknown[]) {
  return arrow.vectorFromArray(values.map(toNullableDate), new arrow.DateDay());
}

function timestampVector(values: unknown[]) {
  return arrow.vectorFromArray(
    values.map(toNullableDateTime),
    new arrow.TimestampMillisecond(),
  );
}

function col(rows: Record<string, unknown>[], name: string): unknown[] {
  return rows.map((row) => row[name]);
}

function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return null;
}

function toNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).slice(0, 10);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNullableDateTime(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function tableToParquetBytes(table: arrow.Table): Uint8Array {
  ensureParquetWasmInitialized();
  const wasmTable = parquetWasm.Table.fromIPCStream(
    arrow.tableToIPC(table, "stream"),
  );
  return parquetWasm.writeParquet(
    wasmTable,
    getWriterProperties() as parquetWasm.WriterProperties,
  );
}

function tableFromColumns(columns: Record<string, unknown>): arrow.Table {
  return (arrow as unknown as {
    tableFromArrays: (data: Record<string, unknown>) => arrow.Table;
  }).tableFromArrays(columns);
}

function dailyRowsToTable(rows: Record<string, unknown>[]): arrow.Table {
  return tableFromColumns({
    day_utc: dateVector(col(rows, "day_utc")),
    day_window_start_exclusive_utc: timestampVector(
      col(rows, "day_window_start_exclusive_utc"),
    ),
    day_window_end_inclusive_utc: timestampVector(
      col(rows, "day_window_end_inclusive_utc"),
    ),
    connector_id: int32Vector(col(rows, "connector_id")),
    source_network_code: textVector(col(rows, "source_network_code")),
    station_id: int32Vector(col(rows, "station_id")),
    timeseries_id: int32Vector(col(rows, "timeseries_id")),
    pollutant_code: textVector(col(rows, "pollutant_code")),
    daily_mean_ugm3: float64Vector(col(rows, "daily_mean_ugm3")),
    valid_hour_count: int32Vector(col(rows, "valid_hour_count")),
    min_valid_hours_per_day: int32Vector(col(rows, "min_valid_hours_per_day")),
    timestamp_convention: textVector(col(rows, "timestamp_convention")),
    data_completeness_pct: float64Vector(col(rows, "data_completeness_pct")),
    who_daily_guideline_ugm3: float64Vector(
      col(rows, "who_daily_guideline_ugm3"),
    ),
    has_enough_data: boolVector(col(rows, "has_enough_data")),
    above_who_daily_guideline: boolVector(
      col(rows, "above_who_daily_guideline"),
    ),
    status_code: textVector(col(rows, "status_code")),
    created_at: timestampVector(col(rows, "created_at")),
    updated_at: timestampVector(col(rows, "updated_at")),
  });
}

function yearlyRowsToTable(rows: Record<string, unknown>[]): arrow.Table {
  return tableFromColumns({
    as_of_day_utc: dateVector(col(rows, "as_of_day_utc")),
    window_start_day_utc: dateVector(col(rows, "window_start_day_utc")),
    window_end_day_utc: dateVector(col(rows, "window_end_day_utc")),
    connector_id: int32Vector(col(rows, "connector_id")),
    source_network_code: textVector(col(rows, "source_network_code")),
    station_id: int32Vector(col(rows, "station_id")),
    timeseries_id: int32Vector(col(rows, "timeseries_id")),
    pollutant_code: textVector(col(rows, "pollutant_code")),
    rolling_year_mean_ugm3: float64Vector(
      col(rows, "rolling_year_mean_ugm3"),
    ),
    valid_day_count: int32Vector(col(rows, "valid_day_count")),
    valid_hour_count: int32Vector(col(rows, "valid_hour_count")),
    period_day_count: int32Vector(col(rows, "period_day_count")),
    min_valid_hours_per_day: int32Vector(col(rows, "min_valid_hours_per_day")),
    min_valid_days: int32Vector(col(rows, "min_valid_days")),
    data_completeness_pct: float64Vector(col(rows, "data_completeness_pct")),
    has_enough_data: boolVector(col(rows, "has_enough_data")),
    who_yearly_guideline_ugm3: float64Vector(
      col(rows, "who_yearly_guideline_ugm3"),
    ),
    above_who_yearly_guideline: boolVector(
      col(rows, "above_who_yearly_guideline"),
    ),
    who_daily_guideline_ugm3: float64Vector(
      col(rows, "who_daily_guideline_ugm3"),
    ),
    daily_above_guideline_days: int32Vector(
      col(rows, "daily_above_guideline_days"),
    ),
    daily_allowance_days: int32Vector(col(rows, "daily_allowance_days")),
    daily_above_guideline_days_beyond_allowance: int32Vector(
      col(rows, "daily_above_guideline_days_beyond_allowance"),
    ),
    above_who_daily_guideline_approach: boolVector(
      col(rows, "above_who_daily_guideline_approach"),
    ),
    created_at: timestampVector(col(rows, "created_at")),
    updated_at: timestampVector(col(rows, "updated_at")),
  });
}

function calendarRowsToTable(rows: Record<string, unknown>[]): arrow.Table {
  return tableFromColumns({
    calendar_year: int32Vector(col(rows, "calendar_year")),
    period_type: textVector(col(rows, "period_type")),
    period_start_day_utc: dateVector(col(rows, "period_start_day_utc")),
    period_end_day_utc: dateVector(col(rows, "period_end_day_utc")),
    connector_id: int32Vector(col(rows, "connector_id")),
    source_network_code: textVector(col(rows, "source_network_code")),
    station_id: int32Vector(col(rows, "station_id")),
    timeseries_id: int32Vector(col(rows, "timeseries_id")),
    pollutant_code: textVector(col(rows, "pollutant_code")),
    period_mean_ugm3: float64Vector(col(rows, "period_mean_ugm3")),
    valid_day_count: int32Vector(col(rows, "valid_day_count")),
    valid_hour_count: int32Vector(col(rows, "valid_hour_count")),
    period_day_count: int32Vector(col(rows, "period_day_count")),
    min_valid_hours_per_day: int32Vector(col(rows, "min_valid_hours_per_day")),
    min_valid_days: int32Vector(col(rows, "min_valid_days")),
    data_completeness_pct: float64Vector(col(rows, "data_completeness_pct")),
    has_enough_data: boolVector(col(rows, "has_enough_data")),
    who_yearly_guideline_ugm3: float64Vector(
      col(rows, "who_yearly_guideline_ugm3"),
    ),
    above_who_yearly_guideline: boolVector(
      col(rows, "above_who_yearly_guideline"),
    ),
    who_daily_guideline_ugm3: float64Vector(
      col(rows, "who_daily_guideline_ugm3"),
    ),
    daily_above_guideline_days: int32Vector(
      col(rows, "daily_above_guideline_days"),
    ),
    daily_allowance_days: int32Vector(col(rows, "daily_allowance_days")),
    daily_above_guideline_days_beyond_allowance: int32Vector(
      col(rows, "daily_above_guideline_days_beyond_allowance"),
    ),
    above_who_daily_guideline_approach: boolVector(
      col(rows, "above_who_daily_guideline_approach"),
    ),
    is_final: boolVector(col(rows, "is_final")),
    created_at: timestampVector(col(rows, "created_at")),
    updated_at: timestampVector(col(rows, "updated_at")),
  });
}

export function validateWho2021ParquetObjectKey(
  dataset: Who2021ParquetDataset,
  objectKey: string,
): void {
  if (!VALID_OBJECT_KEY_RE.test(objectKey)) {
    throw new Error(`invalid WHO 2021 parquet object key: ${objectKey}`);
  }
  if (!objectKey.startsWith(`history/v2/who_2021/${dataset}/`)) {
    throw new Error(
      `WHO 2021 parquet object key does not match dataset ${dataset}: ${objectKey}`,
    );
  }
}

export function rowsToWho2021ParquetBytes(
  batch: Who2021ParquetBatch,
): Uint8Array {
  validateWho2021ParquetObjectKey(batch.dataset, batch.object_key);
  const rows = asRows(batch.rows_json);
  if (rows.length !== Number(batch.row_count)) {
    throw new Error(
      `WHO 2021 parquet row count mismatch for ${batch.object_key}: expected ${batch.row_count}, got ${rows.length}`,
    );
  }
  if (rows.length === 0) {
    throw new Error(`WHO 2021 parquet batch is empty for ${batch.object_key}`);
  }

  if (batch.dataset === "daily_status") {
    return tableToParquetBytes(dailyRowsToTable(rows));
  }
  if (batch.dataset === "rolling_year_status") {
    return tableToParquetBytes(yearlyRowsToTable(rows));
  }
  return tableToParquetBytes(calendarRowsToTable(rows));
}
