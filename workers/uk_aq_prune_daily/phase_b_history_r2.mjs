import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import Cursor from "pg-cursor";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PART_MAX_ROWS = 1_000_000;
const DEFAULT_OBSERVATIONS_PART_MAX_ROWS = 500_000;
const DEFAULT_AQILEVELS_PART_MAX_ROWS = DEFAULT_PART_MAX_ROWS;
const DEFAULT_CURSOR_FETCH_ROWS = 20_000;
const DEFAULT_ROW_GROUP_SIZE = 100_000;
const DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE = 50_000;
const DEFAULT_AQILEVELS_ROW_GROUP_SIZE = DEFAULT_ROW_GROUP_SIZE;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 500;
const DEFAULT_AQILEVELS_SOURCE_MAX_PAGES = 50_000;
const DEFAULT_STAGING_RETENTION_DAYS = 7;
const DEFAULT_STAGING_PREFIX = "history/v1/_ops/observations/staging";
const DEFAULT_COMMITTED_PREFIX = "history/v1/observations";
const DEFAULT_AQILEVELS_PREFIX = "history/v1/aqilevels";
const DEFAULT_RUNS_PREFIX = "history/v1/_ops/observations/runs";
const DEFAULT_INGESTDB_RETENTION_DAYS = 5;

const HISTORY_SCHEMA_NAME = "observations";
const HISTORY_SCHEMA_VERSION = 2;
const WRITER_VERSION = "parquet-wasm-zstd-v2";
const HISTORY_AQILEVELS_SCHEMA_NAME = "aqilevels";
const HISTORY_AQILEVELS_SCHEMA_VERSION = 2;
const HISTORY_AQILEVELS_WRITER_VERSION = "parquet-wasm-zstd-v2";
const AQILEVELS_CONNECTOR_COUNTS_RPC = "uk_aq_rpc_aqilevels_history_day_connector_counts";
const AQILEVELS_ROWS_RPC = "uk_aq_rpc_aqilevels_history_day_rows";
const DEFAULT_RPC_SCHEMA = "uk_aq_public";

export const HISTORY_OBSERVATIONS_COLUMNS_V1 = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
  "status",
  "created_at",
]);
export const HISTORY_OBSERVATIONS_COLUMNS_V2 = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
]);
const HISTORY_OBSERVATIONS_COLUMNS = HISTORY_OBSERVATIONS_COLUMNS_V2;
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

let parquetWasmInitialized = false;

function nowIso() {
  return new Date().toISOString();
}

function toIsoDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function utcMidnightFromIso(isoDate) {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function shiftIsoDay(isoDay, deltaDays) {
  const date = utcMidnightFromIso(isoDay);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toIsoDateUtc(date);
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function parseBigInt(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return 0n;
  }
  try {
    return BigInt(String(value));
  } catch {
    throw new Error(`Invalid bigint for ${fieldName}: ${String(value)}`);
  }
}

function readResponseTextLimit(text, limit = 1000) {
  if (typeof text !== "string") {
    return "";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function normalizeDayUtc(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return "";
    }
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) {
    return "";
  }

  const isoDateMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return text.slice(0, 10);
}

function escapeSingleQuotes(value) {
  return String(value).replace(/'/g, "''");
}

function minIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left >= right ? left : right;
}

function buildManifestHash(payloadWithoutHash) {
  return sha256Hex(JSON.stringify(payloadWithoutHash));
}

function withManifestHash(payloadWithoutHash) {
  return {
    ...payloadWithoutHash,
    manifest_hash: buildManifestHash(payloadWithoutHash),
  };
}

function averageNumber(total, count) {
  if (!count) {
    return null;
  }
  return Number(total) / Number(count);
}

function statsFromFileEntries(fileEntries, totalRows) {
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
  for (let i = 1; i < bytes.length; i++) {
    const value = bytes[i];
    if (value < minBytes) {
      minBytes = value;
    }
    if (value > maxBytes) {
      maxBytes = value;
    }
  }

  return {
    bytes_per_row_estimate: totalRows > 0 ? totalBytes / Number(totalRows) : null,
    avg_file_bytes: averageNumber(totalBytes, bytes.length),
    min_file_bytes: minBytes,
    max_file_bytes: maxBytes,
  };
}

function summarizeObservationPartRows(rows) {
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minObservedAt = null;
  let maxObservedAt = null;

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
      minObservedAt = minIso(minObservedAt, observedAt);
      maxObservedAt = maxIso(maxObservedAt, observedAt);
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
  };
}

function summarizeAqilevelPartRows(rows) {
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;

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
      minTimestampHourUtc = minIso(minTimestampHourUtc, timestampHourUtc);
      maxTimestampHourUtc = maxIso(maxTimestampHourUtc, timestampHourUtc);
    }
  }

  return {
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
  };
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function ensureParquetWasmInitialized() {
  if (parquetWasmInitialized) {
    return;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.resolve(moduleDir, "../../node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  parquetWasm.initSync({ module: wasmBytes });
  parquetWasmInitialized = true;
}

function connectorPrefix(basePrefix, dayUtc, connectorId) {
  return `${basePrefix}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

export function buildConnectorManifestKey(committedPrefix, dayUtc, connectorId) {
  return `${connectorPrefix(committedPrefix, dayUtc, connectorId)}/manifest.json`;
}

export function buildDayManifestKey(committedPrefix, dayUtc) {
  return `${committedPrefix}/day_utc=${dayUtc}/manifest.json`;
}

function buildRunManifestKey(runsPrefix, runId) {
  return `${runsPrefix}/run_id=${runId}/run_manifest.json`;
}

function buildPartKey(prefix, dayUtc, connectorId, partIndex) {
  return `${connectorPrefix(prefix, dayUtc, connectorId)}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

function toPgConnectionConfig(connectionString) {
  return {
    connectionString,
    statement_timeout: 0,
    query_timeout: 0,
    application_name: "uk_aq_prune_daily_phase_b_history",
  };
}

async function withPgClient(connectionString, fn) {
  const client = new Client(toPgConnectionConfig(connectionString));
  await client.connect();
  try {
    await client.query("set timezone = 'UTC'");
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function postgrestRpc({ baseUrl, privilegedKey, rpcSchema, rpcName, payload }) {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: privilegedKey,
      Authorization: `Bearer ${privilegedKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Profile": rpcSchema,
      "Content-Profile": rpcSchema,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && parsed.message
      ? String(parsed.message)
      : readResponseTextLimit(text);
    throw new Error(`PostgREST RPC ${rpcName} failed (${response.status}): ${message}`);
  }

  return parsed;
}

function toResumePartEntry(value, index) {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid resume part entry at index ${index}`);
  }
  const key = String(value.key || "").trim();
  if (!key) {
    throw new Error(`Missing resume part key at index ${index}`);
  }
  const rowCount = Number(value.row_count);
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    throw new Error(`Invalid resume part row_count at index ${index}`);
  }
  const bytes = Number(value.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`Invalid resume part bytes at index ${index}`);
  }
  const etagOrHash = value.etag_or_hash === null || value.etag_or_hash === undefined
    ? null
    : String(value.etag_or_hash);
  const minTimeseriesId = Number(value.min_timeseries_id);
  const maxTimeseriesId = Number(value.max_timeseries_id);
  const minObservedAt = typeof value.min_observed_at === "string"
    ? value.min_observed_at
    : null;
  const maxObservedAt = typeof value.max_observed_at === "string"
    ? value.max_observed_at
    : null;
  const minTimestampHourUtc = typeof value.min_timestamp_hour_utc === "string"
    ? value.min_timestamp_hour_utc
    : null;
  const maxTimestampHourUtc = typeof value.max_timestamp_hour_utc === "string"
    ? value.max_timestamp_hour_utc
    : null;

  return {
    key,
    row_count: Math.trunc(rowCount),
    bytes: Math.trunc(bytes),
    etag_or_hash: etagOrHash,
    min_timeseries_id:
      Number.isFinite(minTimeseriesId) && minTimeseriesId > 0 ? Math.trunc(minTimeseriesId) : null,
    max_timeseries_id:
      Number.isFinite(maxTimeseriesId) && maxTimeseriesId > 0 ? Math.trunc(maxTimeseriesId) : null,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
  };
}

function parseResumeParts(value) {
  if (value === null || value === undefined || value === "") {
    return [];
  }

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Invalid resume_parts_json payload.");
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("resume_parts_json must be an array.");
  }

  return parsed.map((entry, index) => toResumePartEntry(entry, index));
}

function toConnectorDayRow(row) {
  return {
    day_utc: normalizeDayUtc(row.day_utc),
    connector_id: Number(row.connector_id),
    expected_row_count: parseBigInt(row.expected_row_count, "expected_row_count"),
    min_observed_at: row.min_observed_at ? new Date(row.min_observed_at).toISOString() : null,
    max_observed_at: row.max_observed_at ? new Date(row.max_observed_at).toISOString() : null,
    status: String(row.status || "pending"),
    run_id: row.run_id ? String(row.run_id) : null,
    manifest_key: row.manifest_key ? String(row.manifest_key) : null,
    history_row_count: row.history_row_count === null || row.history_row_count === undefined
      ? null
      : parseBigInt(row.history_row_count, "history_row_count"),
    history_file_count: row.history_file_count === null || row.history_file_count === undefined
      ? null
      : Number(row.history_file_count),
    history_total_bytes: row.history_total_bytes === null || row.history_total_bytes === undefined
      ? null
      : parseBigInt(row.history_total_bytes, "history_total_bytes"),
    resume_last_timeseries_id: row.resume_last_timeseries_id === null || row.resume_last_timeseries_id === undefined
      ? null
      : Number(row.resume_last_timeseries_id),
    resume_last_observed_at: row.resume_last_observed_at
      ? new Date(row.resume_last_observed_at).toISOString()
      : null,
    resume_part_index: row.resume_part_index === null || row.resume_part_index === undefined
      ? 0
      : Number(row.resume_part_index),
    resume_exported_row_count: row.resume_exported_row_count === null || row.resume_exported_row_count === undefined
      ? 0n
      : parseBigInt(row.resume_exported_row_count, "resume_exported_row_count"),
    resume_parts: parseResumeParts(row.resume_parts_json),
  };
}

async function populateBackupCandidates(client, latestEligibleWindowEndIso) {
  const sql = `
with eligible as (
  select
    (o.observed_at at time zone 'UTC')::date as day_utc,
    o.connector_id::integer as connector_id,
    count(*)::bigint as expected_row_count,
    min(o.observed_at) as min_observed_at,
    max(o.observed_at) as max_observed_at
  from uk_aq_core.observations o
  left join uk_aq_ops.history_candidates existing_complete
    on existing_complete.day_utc = (o.observed_at at time zone 'UTC')::date
   and existing_complete.connector_id = o.connector_id
   and existing_complete.status = 'complete'
  where o.observed_at < $1::timestamptz
    and existing_complete.day_utc is null
  group by 1, 2
),
upserted as (
  insert into uk_aq_ops.history_candidates (
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    last_error,
    manifest_key,
    history_row_count,
    history_file_count,
    history_total_bytes,
    history_completed_at,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
  )
  select
    e.day_utc,
    e.connector_id,
    e.expected_row_count,
    e.min_observed_at,
    e.max_observed_at,
    'pending'::text,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    0,
    0,
    '[]'::jsonb
  from eligible e
  on conflict (day_utc, connector_id)
  do update set
    expected_row_count = excluded.expected_row_count,
    min_observed_at = excluded.min_observed_at,
    max_observed_at = excluded.max_observed_at,
    status = 'pending',
    run_id = null,
    last_error = null,
    manifest_key = null,
    history_row_count = null,
    history_file_count = null,
    history_total_bytes = null,
    history_completed_at = null,
    resume_last_timeseries_id = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.resume_last_timeseries_id
      else null
    end,
    resume_last_observed_at = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then uk_aq_ops.history_candidates.resume_last_observed_at
      else null
    end,
    resume_part_index = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_part_index, 0)
      else 0
    end,
    resume_exported_row_count = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_exported_row_count, 0)
      else 0
    end,
    resume_parts_json = case
      when uk_aq_ops.history_candidates.expected_row_count = excluded.expected_row_count
       and uk_aq_ops.history_candidates.min_observed_at is not distinct from excluded.min_observed_at
       and uk_aq_ops.history_candidates.max_observed_at is not distinct from excluded.max_observed_at
      then coalesce(uk_aq_ops.history_candidates.resume_parts_json, '[]'::jsonb)
      else '[]'::jsonb
    end,
    updated_at = now()
  where uk_aq_ops.history_candidates.status <> 'complete'
  returning
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    manifest_key,
    history_row_count,
    history_file_count,
    history_total_bytes,
    resume_last_timeseries_id,
    resume_last_observed_at,
    resume_part_index,
    resume_exported_row_count,
    resume_parts_json
)
select * from upserted
order by day_utc, connector_id
`;

  const result = await client.query(sql, [latestEligibleWindowEndIso]);
  return result.rows.map(toConnectorDayRow);
}

async function markIncompleteDaysAsBackupBlocked(client) {
  const sql = `
with day_status as (
  select
    c.day_utc,
    bool_and(c.status = 'complete') as all_complete
  from uk_aq_ops.history_candidates c
  group by c.day_utc
)
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
select
  d.day_utc,
  false,
  null,
  null,
  null,
  null,
  null,
  null,
  now()
from day_status d
where d.all_complete = false
on conflict (day_utc)
do update set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  updated_at = now()
`;
  await client.query(sql);
}

async function fetchPendingCandidates(client, maxCandidatesPerRun) {
  const sql = `
select
  c.day_utc,
  c.connector_id,
  c.expected_row_count,
  c.min_observed_at,
  c.max_observed_at,
  c.status,
  c.run_id,
  c.manifest_key,
  c.history_row_count,
  c.history_file_count,
  c.history_total_bytes,
  c.resume_last_timeseries_id,
  c.resume_last_observed_at,
  c.resume_part_index,
  c.resume_exported_row_count,
  c.resume_parts_json
from uk_aq_ops.history_candidates c
where c.status = 'pending'
order by c.day_utc, c.connector_id
limit $1
`;

  const result = await client.query(sql, [maxCandidatesPerRun]);
  return result.rows.map(toConnectorDayRow);
}

async function markCandidateInProgress(client, dayUtc, connectorId, runId) {
  const result = await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'in_progress',
  run_id = $3,
  last_error = null,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
  and status = 'pending'
returning day_utc
`,
    [dayUtc, connectorId, runId],
  );
  return result.rowCount > 0;
}

async function markCandidateComplete(client, {
  dayUtc,
  connectorId,
  runId,
  manifestKey,
  historyRowCount,
  historyFileCount,
  historyTotalBytes,
}) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'complete',
  run_id = $3,
  last_error = null,
  manifest_key = $4,
  history_row_count = $5,
  history_file_count = $6,
  history_total_bytes = $7,
  resume_last_timeseries_id = null,
  resume_last_observed_at = null,
  resume_part_index = 0,
  resume_exported_row_count = 0,
  resume_parts_json = '[]'::jsonb,
  history_completed_at = now(),
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [
      dayUtc,
      connectorId,
      runId,
      manifestKey,
      historyRowCount.toString(),
      historyFileCount,
      historyTotalBytes.toString(),
    ],
  );
}

async function updateCandidateResumeCheckpoint(client, {
  dayUtc,
  connectorId,
  runId,
  lastTimeseriesId,
  lastObservedAt,
  partIndex,
  exportedRowCount,
  parts,
}) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  resume_last_timeseries_id = $4,
  resume_last_observed_at = $5,
  resume_part_index = $6,
  resume_exported_row_count = $7,
  resume_parts_json = $8::jsonb,
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
  and run_id = $3
`,
    [
      dayUtc,
      connectorId,
      runId,
      lastTimeseriesId,
      lastObservedAt,
      partIndex,
      exportedRowCount.toString(),
      JSON.stringify(parts),
    ],
  );
}

async function markCandidateFailed(client, { dayUtc, connectorId, runId, errorText }) {
  await client.query(
    `
update uk_aq_ops.history_candidates
set
  status = 'failed',
  run_id = $3,
  last_error = left($4, 4000),
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [dayUtc, connectorId, runId, errorText],
  );
}

async function fetchDayCandidates(client, dayUtc) {
  const result = await client.query(
    `
select
  day_utc,
  connector_id,
  expected_row_count,
  min_observed_at,
  max_observed_at,
  status,
  run_id,
  manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  resume_last_timeseries_id,
  resume_last_observed_at,
  resume_part_index,
  resume_exported_row_count,
  resume_parts_json
from uk_aq_ops.history_candidates
where day_utc = $1::date
order by connector_id
`,
    [dayUtc],
  );
  return result.rows.map(toConnectorDayRow);
}

export function computeDayGateState(dayCandidates) {
  const total = dayCandidates.length;
  const complete = dayCandidates.filter((row) => row.status === "complete").length;
  const failed = dayCandidates.filter((row) => row.status === "failed").length;
  const pending = dayCandidates.filter((row) => row.status === "pending").length;
  const inProgress = dayCandidates.filter((row) => row.status === "in_progress").length;
  const allComplete = total > 0 && complete === total;
  return {
    total,
    complete,
    failed,
    pending,
    in_progress: inProgress,
    all_complete: allComplete,
  };
}

async function updateDayGateBlocked(client, dayUtc) {
  await client.query(
    `
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
values ($1::date, false, null, null, null, null, null, null, now())
on conflict (day_utc)
do update set
  history_done = false,
  history_run_id = null,
  history_manifest_key = null,
  history_row_count = null,
  history_file_count = null,
  history_total_bytes = null,
  history_completed_at = null,
  updated_at = now()
`,
    [dayUtc],
  );
}

async function updateDayGateComplete(client, {
  dayUtc,
  runId,
  manifestKey,
  rowCount,
  fileCount,
  totalBytes,
}) {
  await client.query(
    `
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  history_done,
  history_run_id,
  history_manifest_key,
  history_row_count,
  history_file_count,
  history_total_bytes,
  history_completed_at,
  updated_at
)
values (
  $1::date,
  true,
  $2,
  $3,
  $4,
  $5,
  $6,
  now(),
  now()
)
on conflict (day_utc)
do update set
  history_done = true,
  history_run_id = excluded.history_run_id,
  history_manifest_key = excluded.history_manifest_key,
  history_row_count = excluded.history_row_count,
  history_file_count = excluded.history_file_count,
  history_total_bytes = excluded.history_total_bytes,
  history_completed_at = now(),
  updated_at = now()
`,
    [dayUtc, runId, manifestKey, rowCount.toString(), fileCount, totalBytes.toString()],
  );
}

function createConnectorManifest({
  dayUtc,
  connectorId,
  runId,
  sourceRowCount,
  minObservedAt,
  maxObservedAt,
  fileEntries,
  writerGitSha,
  backedUpAtUtc,
}) {
  const parquetObjectKeys = fileEntries.map((entry) => entry.key);
  const totalBytes = fileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const stats = statsFromFileEntries(fileEntries, sourceRowCount);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: connectorId,
    run_id: runId,
    source_row_count: Number(sourceRowCount),
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    files: fileEntries,
    history_schema_name: HISTORY_SCHEMA_NAME,
    history_schema_version: HISTORY_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

export function buildConnectorManifestForTest(args) {
  return createConnectorManifest(args);
}

function createDayManifest({ dayUtc, runId, connectorManifests, writerGitSha, backedUpAtUtc }) {
  const files = connectorManifests.flatMap((manifest) =>
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

  const parquetObjectKeys = uniqueSorted(files.map((entry) => entry.key));
  const totalRows = connectorManifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const connectorIds = connectorManifests.map((manifest) => Number(manifest.connector_id));

  const minObservedAt = connectorManifests.reduce(
    (current, manifest) => minIso(current, manifest.min_observed_at || null),
    null,
  );
  const maxObservedAt = connectorManifests.reduce(
    (current, manifest) => maxIso(current, manifest.max_observed_at || null),
    null,
  );

  const stats = statsFromFileEntries(files, totalRows);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: runId,
    source_row_count: totalRows,
    min_observed_at: minObservedAt,
    max_observed_at: maxObservedAt,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: connectorManifests.map((manifest) => ({
      connector_id: manifest.connector_id,
      manifest_key: manifest.manifest_key,
      source_row_count: manifest.source_row_count,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
    })),
    history_schema_name: HISTORY_SCHEMA_NAME,
    history_schema_version: HISTORY_SCHEMA_VERSION,
    columns: HISTORY_OBSERVATIONS_COLUMNS,
    writer_version: WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

function createAqilevelConnectorManifest({
  dayUtc,
  connectorId,
  runId,
  sourceRowCount,
  minTimeseriesId,
  maxTimeseriesId,
  minTimestampHourUtc,
  maxTimestampHourUtc,
  fileEntries,
  writerGitSha,
  backedUpAtUtc,
}) {
  const parquetObjectKeys = fileEntries.map((entry) => entry.key);
  const totalBytes = fileEntries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  const resolvedMinTimeseriesId = Number.isFinite(Number(minTimeseriesId))
    && Number(minTimeseriesId) > 0
    ? Math.trunc(Number(minTimeseriesId))
    : fileEntries.reduce((current, entry) => {
      const value = Number(entry.min_timeseries_id);
      if (!Number.isFinite(value) || value <= 0) {
        return current;
      }
      const normalized = Math.trunc(value);
      return current === null ? normalized : Math.min(current, normalized);
    }, null);
  const resolvedMaxTimeseriesId = Number.isFinite(Number(maxTimeseriesId))
    && Number(maxTimeseriesId) > 0
    ? Math.trunc(Number(maxTimeseriesId))
    : fileEntries.reduce((current, entry) => {
      const value = Number(entry.max_timeseries_id);
      if (!Number.isFinite(value) || value <= 0) {
        return current;
      }
      const normalized = Math.trunc(value);
      return current === null ? normalized : Math.max(current, normalized);
    }, null);
  const stats = statsFromFileEntries(fileEntries, sourceRowCount);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: connectorId,
    run_id: runId,
    source_row_count: Number(sourceRowCount),
    min_timeseries_id: resolvedMinTimeseriesId,
    max_timeseries_id: resolvedMaxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    files: fileEntries,
    history_schema_name: HISTORY_AQILEVELS_SCHEMA_NAME,
    history_schema_version: HISTORY_AQILEVELS_SCHEMA_VERSION,
    columns: HISTORY_AQILEVELS_COLUMNS,
    writer_version: HISTORY_AQILEVELS_WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

function createAqilevelDayManifest({ dayUtc, runId, connectorManifests, writerGitSha, backedUpAtUtc }) {
  const files = connectorManifests.flatMap((manifest) =>
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

  const parquetObjectKeys = uniqueSorted(files.map((entry) => entry.key));
  const totalRows = connectorManifests.reduce((sum, manifest) => sum + Number(manifest.source_row_count || 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const connectorIds = connectorManifests.map((manifest) => Number(manifest.connector_id));
  const minTimeseriesId = connectorManifests.reduce((current, manifest) => {
    const value = Number(manifest.min_timeseries_id);
    if (!Number.isFinite(value) || value <= 0) {
      return current;
    }
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.min(current, normalized);
  }, null);
  const maxTimeseriesId = connectorManifests.reduce((current, manifest) => {
    const value = Number(manifest.max_timeseries_id);
    if (!Number.isFinite(value) || value <= 0) {
      return current;
    }
    const normalized = Math.trunc(value);
    return current === null ? normalized : Math.max(current, normalized);
  }, null);

  const minTimestampHourUtc = connectorManifests.reduce(
    (current, manifest) => minIso(current, manifest.min_timestamp_hour_utc || null),
    null,
  );
  const maxTimestampHourUtc = connectorManifests.reduce(
    (current, manifest) => maxIso(current, manifest.max_timestamp_hour_utc || null),
    null,
  );

  const stats = statsFromFileEntries(files, totalRows);

  return withManifestHash({
    day_utc: dayUtc,
    connector_id: null,
    connector_ids: connectorIds,
    run_id: runId,
    source_row_count: totalRows,
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    min_timestamp_hour_utc: minTimestampHourUtc,
    max_timestamp_hour_utc: maxTimestampHourUtc,
    parquet_object_keys: parquetObjectKeys,
    file_count: files.length,
    total_bytes: totalBytes,
    files,
    connector_manifests: connectorManifests.map((manifest) => ({
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
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

const PARQUET_WRITER_PROPERTIES_CACHE = new Map();

function parquetWriterProperties(rowGroupSize, createdBy = WRITER_VERSION) {
  const key = Number(rowGroupSize);
  const cacheKey = `${key}:${createdBy}`;
  if (PARQUET_WRITER_PROPERTIES_CACHE.has(cacheKey)) {
    return PARQUET_WRITER_PROPERTIES_CACHE.get(cacheKey);
  }

  ensureParquetWasmInitialized();
  const writerProperties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(key)
    .setCreatedBy(createdBy)
    .build();

  PARQUET_WRITER_PROPERTIES_CACHE.set(cacheKey, writerProperties);
  return writerProperties;
}

function rowsToParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const table = arrow.tableFromArrays({
    connector_id: Int32Array.from(rows.map((row) => Number(row.connector_id))),
    timeseries_id: Int32Array.from(rows.map((row) => Number(row.timeseries_id))),
    observed_at: rows.map((row) => new Date(row.observed_at)),
    value: rows.map((row) => (row.value === null || row.value === undefined ? null : Number(row.value))),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

function rowsToAqilevelParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const table = arrow.tableFromArrays({
    connector_id: rows.map((row) => Number(row.connector_id)),
    timeseries_id: rows.map((row) => Number(row.timeseries_id)),
    station_id: rows.map((row) => Number(row.station_id)),
    pollutant_code: rows.map((row) => String(row.pollutant_code || "")),
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
    daqi_pm25_rolling24h_index_level: rows.map((row) => row.daqi_pm25_rolling24h_index_level),
    daqi_pm10_rolling24h_index_level: rows.map((row) => row.daqi_pm10_rolling24h_index_level),
    eaqi_no2_index_level: rows.map((row) => row.eaqi_no2_index_level),
    eaqi_pm25_index_level: rows.map((row) => row.eaqi_pm25_index_level),
    eaqi_pm10_index_level: rows.map((row) => row.eaqi_pm10_index_level),
  });

  const wasmTable = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(table, "stream"));
  const parquetBytes = parquetWasm.writeParquet(wasmTable, writerProperties);
  return Buffer.from(parquetBytes);
}

async function closeCursor(cursor) {
  await new Promise((resolve, reject) => {
    cursor.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function cursorRead(cursor, rowCount) {
  return await new Promise((resolve, reject) => {
    cursor.read(rowCount, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

async function writeCommittedPartAndCheckpoint({
  streamClient,
  runtime,
  dayUtc,
  connectorId,
  partIndex,
  rows,
  committedParts,
  observedRows,
  totalBytes,
}) {
  const parquetBuffer = rowsToParquetBuffer(
    rows,
    parquetWriterProperties(runtime.observations_row_group_size),
  );
  const committedKey = buildPartKey(runtime.committed_prefix, dayUtc, connectorId, partIndex);
  const putResult = await r2PutObject({
    r2: runtime.r2,
    key: committedKey,
    body: parquetBuffer,
    content_type: "application/octet-stream",
  });
  const head = await r2HeadObject({ r2: runtime.r2, key: committedKey });
  if (!head.exists) {
    throw new Error(`Missing committed object after write: ${committedKey}`);
  }

  const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
    ? Math.trunc(head.bytes)
    : Math.trunc(putResult.bytes);
  const etagOrHash = head.etag || putResult.etag || null;
  const partSummary = summarizeObservationPartRows(rows);
  const partEntry = {
    key: committedKey,
    row_count: rows.length,
    bytes,
    etag_or_hash: etagOrHash,
    min_timeseries_id: partSummary.min_timeseries_id,
    max_timeseries_id: partSummary.max_timeseries_id,
    min_observed_at: partSummary.min_observed_at,
    max_observed_at: partSummary.max_observed_at,
  };
  const nextParts = [...committedParts, partEntry];
  const nextObservedRows = observedRows + BigInt(rows.length);
  const nextTotalBytes = totalBytes + BigInt(bytes);
  const nextPartIndex = partIndex + 1;
  const lastRow = rows[rows.length - 1];

  await updateCandidateResumeCheckpoint(streamClient, {
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    lastTimeseriesId: Number(lastRow.timeseries_id),
    lastObservedAt: new Date(lastRow.observed_at).toISOString(),
    partIndex: nextPartIndex,
    exportedRowCount: nextObservedRows,
    parts: nextParts,
  });

  return {
    partIndex: nextPartIndex,
    committedParts: nextParts,
    observedRows: nextObservedRows,
    totalBytes: nextTotalBytes,
  };
}

async function exportCandidateToR2({ candidate, runtime }) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;

  const expectedRowCount = candidate.expected_row_count;
  let committedParts = [...candidate.resume_parts];
  let observedRows = candidate.resume_exported_row_count;
  const observedRowsFromParts = committedParts.reduce(
    (sum, part) => sum + BigInt(part.row_count),
    0n,
  );
  if (observedRows !== observedRowsFromParts) {
    observedRows = observedRowsFromParts;
  }
  let totalBytes = committedParts.reduce(
    (sum, part) => sum + BigInt(part.bytes),
    0n,
  );
  let partIndex = Number(candidate.resume_part_index || 0);
  const resumeTimeseriesId = candidate.resume_last_timeseries_id;
  const resumeObservedAt = candidate.resume_last_observed_at;

  if (partIndex !== committedParts.length) {
    throw new Error(
      `Resume checkpoint mismatch for day=${dayUtc} connector=${connectorId}: part_index=${partIndex} parts=${committedParts.length}`,
    );
  }
  if (partIndex > 0 && (resumeTimeseriesId === null || !resumeObservedAt)) {
    throw new Error(
      `Resume checkpoint missing key tuple for day=${dayUtc} connector=${connectorId} with part_index=${partIndex}`,
    );
  }

  for (const part of committedParts) {
    const head = await r2HeadObject({ r2: runtime.r2, key: part.key });
    if (!head.exists) {
      throw new Error(`Resume checkpoint references missing committed object: ${part.key}`);
    }
    if (typeof head.bytes === "number" && Number.isFinite(head.bytes)) {
      part.bytes = Math.trunc(head.bytes);
    }
    part.etag_or_hash = head.etag || part.etag_or_hash || null;
  }
  totalBytes = committedParts.reduce((sum, part) => sum + BigInt(part.bytes), 0n);

  await withPgClient(runtime.supabase_db_url, async (streamClient) => {
    const sql = `
select
  connector_id,
  timeseries_id,
  observed_at,
  value
from uk_aq_ops.uk_aq_phase_b_history_rows(
  $1::integer,
  $2::timestamptz,
  $3::timestamptz,
  $4::integer,
  $5::timestamptz
)
`;

    const cursor = streamClient.query(
      new Cursor(sql, [connectorId, dayStart, dayEnd, resumeTimeseriesId, resumeObservedAt]),
    );
    let pendingRows = [];

    try {
      for (;;) {
        const rows = await cursorRead(cursor, runtime.cursor_fetch_rows);
        if (!rows.length) {
          break;
        }

        for (const row of rows) {
          pendingRows.push({
            connector_id: Number(row.connector_id),
            timeseries_id: Number(row.timeseries_id),
            observed_at: row.observed_at,
            value: row.value,
          });

          if (pendingRows.length >= runtime.observations_part_max_rows) {
            const flushed = await writeCommittedPartAndCheckpoint({
              streamClient,
              runtime,
              dayUtc,
              connectorId,
              partIndex,
              rows: pendingRows,
              committedParts,
              observedRows,
              totalBytes,
            });
            partIndex = flushed.partIndex;
            committedParts = flushed.committedParts;
            observedRows = flushed.observedRows;
            totalBytes = flushed.totalBytes;
            pendingRows = [];
          }
        }
      }

      if (pendingRows.length > 0) {
        const flushed = await writeCommittedPartAndCheckpoint({
          streamClient,
          runtime,
          dayUtc,
          connectorId,
          partIndex,
          rows: pendingRows,
          committedParts,
          observedRows,
          totalBytes,
        });
        partIndex = flushed.partIndex;
        committedParts = flushed.committedParts;
        observedRows = flushed.observedRows;
        totalBytes = flushed.totalBytes;
      }
    } finally {
      await closeCursor(cursor);
    }
  });

  if (observedRows !== expectedRowCount) {
    throw new Error(
      `Row count mismatch for day=${dayUtc} connector=${connectorId}: expected=${expectedRowCount.toString()} observed=${observedRows.toString()}`,
    );
  }

  const backedUpAtUtc = nowIso();
  const connectorManifest = createConnectorManifest({
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    sourceRowCount: Number(expectedRowCount),
    minObservedAt: candidate.min_observed_at,
    maxObservedAt: candidate.max_observed_at,
    fileEntries: committedParts,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc,
  });

  const connectorManifestKey = buildConnectorManifestKey(runtime.committed_prefix, dayUtc, connectorId);
  await r2PutObject({
    r2: runtime.r2,
    key: connectorManifestKey,
    body: Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Connector manifest missing after upload: ${connectorManifestKey}`);
  }

  return {
    day_utc: dayUtc,
    connector_id: connectorId,
    manifest_key: connectorManifestKey,
    source_row_count: expectedRowCount,
    written_row_count: observedRows,
    file_count: committedParts.length,
    total_bytes: totalBytes,
    parquet_object_keys: committedParts.map((part) => part.key),
    files: committedParts,
  };
}

function toAqilevelConnectorCountRow(row) {
  const expectedRowCountValue = row.expected_row_count === undefined
    ? row.row_count
    : row.expected_row_count;
  return {
    connector_id: Number(row.connector_id),
    expected_row_count: parseBigInt(expectedRowCountValue, "aqi_expected_row_count"),
    min_timeseries_id: Number.isFinite(Number(row.min_timeseries_id))
      ? Math.max(1, Math.trunc(Number(row.min_timeseries_id)))
      : null,
    max_timeseries_id: Number.isFinite(Number(row.max_timeseries_id))
      ? Math.max(1, Math.trunc(Number(row.max_timeseries_id)))
      : null,
    min_timestamp_hour_utc: row.min_timestamp_hour_utc
      ? new Date(row.min_timestamp_hour_utc).toISOString()
      : null,
    max_timestamp_hour_utc: row.max_timestamp_hour_utc
      ? new Date(row.max_timestamp_hour_utc).toISOString()
      : null,
  };
}

function hasAqilevelSourceConfig(runtime) {
  const source = runtime?.aqilevels_source || {};
  return Boolean(
    String(source.base_url || "").trim()
    && String(source.privileged_key || "").trim()
    && String(source.rpc_schema || "").trim()
    && String(source.connector_counts_rpc || "").trim()
    && String(source.rows_rpc || "").trim(),
  );
}

function normalizeAqilevelHistoryRow(row, connectorIdFallback = null) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const pollutantCode = String(row.pollutant_code || "").trim().toLowerCase();
  const parsed = {
    timeseries_id: Number(row.timeseries_id),
    station_id: Number(row.station_id),
    connector_id: Number.isFinite(Number(row.connector_id)) && Number(row.connector_id) > 0
      ? Number(row.connector_id)
      : Number.isFinite(Number(connectorIdFallback)) && Number(connectorIdFallback) > 0
      ? Number(connectorIdFallback)
      : null,
    pollutant_code: (
      pollutantCode === "no2" || pollutantCode === "pm25" || pollutantCode === "pm10"
    )
      ? pollutantCode
      : null,
    timestamp_hour_utc: row.timestamp_hour_utc ? new Date(row.timestamp_hour_utc).toISOString() : null,
    no2_hourly_mean_ugm3: row.no2_hourly_mean_ugm3 === null || row.no2_hourly_mean_ugm3 === undefined
      ? null
      : Number(row.no2_hourly_mean_ugm3),
    pm25_hourly_mean_ugm3: row.pm25_hourly_mean_ugm3 === null || row.pm25_hourly_mean_ugm3 === undefined
      ? null
      : Number(row.pm25_hourly_mean_ugm3),
    pm10_hourly_mean_ugm3: row.pm10_hourly_mean_ugm3 === null || row.pm10_hourly_mean_ugm3 === undefined
      ? null
      : Number(row.pm10_hourly_mean_ugm3),
    pm25_rolling24h_mean_ugm3: row.pm25_rolling24h_mean_ugm3 === null || row.pm25_rolling24h_mean_ugm3 === undefined
      ? null
      : Number(row.pm25_rolling24h_mean_ugm3),
    pm10_rolling24h_mean_ugm3: row.pm10_rolling24h_mean_ugm3 === null || row.pm10_rolling24h_mean_ugm3 === undefined
      ? null
      : Number(row.pm10_rolling24h_mean_ugm3),
    hourly_sample_count: row.hourly_sample_count === null || row.hourly_sample_count === undefined
      ? null
      : Number(row.hourly_sample_count),
    daqi_index_level: row.daqi_index_level === null || row.daqi_index_level === undefined
      ? null
      : Number(row.daqi_index_level),
    eaqi_index_level: row.eaqi_index_level === null || row.eaqi_index_level === undefined
      ? null
      : Number(row.eaqi_index_level),
    daqi_no2_index_level: row.daqi_no2_index_level === null || row.daqi_no2_index_level === undefined
      ? null
      : Number(row.daqi_no2_index_level),
    daqi_pm25_rolling24h_index_level: row.daqi_pm25_rolling24h_index_level === null
      || row.daqi_pm25_rolling24h_index_level === undefined
      ? null
      : Number(row.daqi_pm25_rolling24h_index_level),
    daqi_pm10_rolling24h_index_level: row.daqi_pm10_rolling24h_index_level === null
      || row.daqi_pm10_rolling24h_index_level === undefined
      ? null
      : Number(row.daqi_pm10_rolling24h_index_level),
    eaqi_no2_index_level: row.eaqi_no2_index_level === null || row.eaqi_no2_index_level === undefined
      ? null
      : Number(row.eaqi_no2_index_level),
    eaqi_pm25_index_level: row.eaqi_pm25_index_level === null || row.eaqi_pm25_index_level === undefined
      ? null
      : Number(row.eaqi_pm25_index_level),
    eaqi_pm10_index_level: row.eaqi_pm10_index_level === null || row.eaqi_pm10_index_level === undefined
      ? null
      : Number(row.eaqi_pm10_index_level),
  };

  if (
    !Number.isFinite(parsed.timeseries_id) || parsed.timeseries_id <= 0 ||
    !Number.isFinite(parsed.station_id) || parsed.station_id <= 0 ||
    !Number.isFinite(parsed.connector_id) || parsed.connector_id <= 0 ||
    !parsed.pollutant_code ||
    !parsed.timestamp_hour_utc
  ) {
    return null;
  }
  return parsed;
}

async function fetchAqilevelConnectorCounts(runtime, dayUtc) {
  const payload = await postgrestRpc({
    baseUrl: runtime.aqilevels_source.base_url,
    privilegedKey: runtime.aqilevels_source.privileged_key,
    rpcSchema: runtime.aqilevels_source.rpc_schema,
    rpcName: runtime.aqilevels_source.connector_counts_rpc,
    payload: {
      p_day_utc: dayUtc,
      p_connector_ids: null,
    },
  });

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map(toAqilevelConnectorCountRow)
    .filter((row) => Number.isInteger(row.connector_id) && row.connector_id > 0 && row.expected_row_count > 0n);
}

async function fetchAqilevelRowsPage(runtime, { dayUtc, connectorId, afterTimeseriesId, afterTimestampHourUtc, limit }) {
  const payload = await postgrestRpc({
    baseUrl: runtime.aqilevels_source.base_url,
    privilegedKey: runtime.aqilevels_source.privileged_key,
    rpcSchema: runtime.aqilevels_source.rpc_schema,
    rpcName: runtime.aqilevels_source.rows_rpc,
    payload: {
      p_day_utc: dayUtc,
      p_connector_id: connectorId,
      p_after_timeseries_id: afterTimeseriesId,
      p_after_timestamp_hour_utc: afterTimestampHourUtc,
      p_limit: limit,
    },
  });

  if (!Array.isArray(payload)) {
    return [];
  }

  const normalized = [];
  for (const row of payload) {
    const parsed = normalizeAqilevelHistoryRow(row, connectorId);
    if (parsed) {
      normalized.push(parsed);
    }
  }
  return normalized;
}

async function fetchAqilevelCandidateDays(client, latestEligibleDayUtc, scanLimit) {
  const sql = `
select g.day_utc::text as day_utc
from uk_aq_ops.prune_day_gates g
where g.history_done is true
  and g.day_utc <= $1::date
order by g.day_utc desc
limit $2
`;
  const result = await client.query(sql, [latestEligibleDayUtc, scanLimit]);
  return result.rows.map((row) => normalizeDayUtc(row.day_utc)).filter(Boolean);
}

async function discoverPendingAqilevelDays({ client, runtime, latestEligibleDayUtc }) {
  const scanLimit = Math.max(runtime.max_candidates_per_run * 4, runtime.max_candidates_per_run);
  const candidates = await fetchAqilevelCandidateDays(client, latestEligibleDayUtc, scanLimit);
  const pending = [];

  for (const dayUtc of candidates) {
    const manifestKey = buildDayManifestKey(runtime.aqilevels_prefix, dayUtc);
    const head = await r2HeadObject({ r2: runtime.r2, key: manifestKey });
    if (!head.exists) {
      pending.push(dayUtc);
    }
    if (pending.length >= runtime.max_candidates_per_run) {
      break;
    }
  }

  return uniqueSorted(pending);
}

async function exportAqilevelConnectorDayToR2({ runtime, dayUtc, connector }) {
  const connectorId = Number(connector.connector_id);
  const expectedRowCount = connector.expected_row_count;
  const fileEntries = [];
  let partIndex = 0;
  let pendingRows = [];
  let observedRows = 0n;
  let totalBytes = 0n;
  let minTimestampHourUtc = null;
  let maxTimestampHourUtc = null;
  let cursorAfterTimeseriesId = null;
  let cursorAfterTimestampHourUtc = null;
  let pageCount = 0;

  const flushPart = async () => {
    if (!pendingRows.length) {
      return;
    }
    const partRows = pendingRows;
    pendingRows = [];
    const partSummary = summarizeAqilevelPartRows(partRows);

    const partKey = buildPartKey(runtime.aqilevels_prefix, dayUtc, connectorId, partIndex);
    const parquetBuffer = rowsToAqilevelParquetBuffer(
      partRows,
      parquetWriterProperties(
        runtime.aqilevels_row_group_size,
        HISTORY_AQILEVELS_WRITER_VERSION,
      ),
    );
    const putResult = await r2PutObject({
      r2: runtime.r2,
      key: partKey,
      body: parquetBuffer,
      content_type: "application/octet-stream",
    });
    const head = await r2HeadObject({ r2: runtime.r2, key: partKey });
    if (!head.exists) {
      throw new Error(`Missing AQI committed object after write: ${partKey}`);
    }
    const bytes = typeof head.bytes === "number" && Number.isFinite(head.bytes)
      ? Math.trunc(head.bytes)
      : Math.trunc(putResult.bytes);
    const etagOrHash = head.etag || putResult.etag || null;

    fileEntries.push({
      key: partKey,
      row_count: partRows.length,
      bytes,
      etag_or_hash: etagOrHash,
      min_timeseries_id: partSummary.min_timeseries_id,
      max_timeseries_id: partSummary.max_timeseries_id,
      min_timestamp_hour_utc: partSummary.min_timestamp_hour_utc,
      max_timestamp_hour_utc: partSummary.max_timestamp_hour_utc,
    });
    partIndex += 1;
    observedRows += BigInt(partRows.length);
    totalBytes += BigInt(bytes);
  };

  for (;;) {
    pageCount += 1;
    if (pageCount > runtime.aqilevels_source_max_pages) {
      throw new Error(
        `AQI source RPC exceeded max pages (${runtime.aqilevels_source_max_pages}) for day=${dayUtc} connector=${connectorId}`,
      );
    }

    const pageRows = await fetchAqilevelRowsPage(runtime, {
      dayUtc,
      connectorId,
      afterTimeseriesId: cursorAfterTimeseriesId,
      afterTimestampHourUtc: cursorAfterTimestampHourUtc,
      limit: runtime.cursor_fetch_rows,
    });
    if (!pageRows.length) {
      break;
    }

    for (const row of pageRows) {
      if (!minTimestampHourUtc || row.timestamp_hour_utc < minTimestampHourUtc) {
        minTimestampHourUtc = row.timestamp_hour_utc;
      }
      if (!maxTimestampHourUtc || row.timestamp_hour_utc > maxTimestampHourUtc) {
        maxTimestampHourUtc = row.timestamp_hour_utc;
      }

      pendingRows.push({
        connector_id: connectorId,
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

      if (pendingRows.length >= runtime.aqilevels_part_max_rows) {
        await flushPart();
      }
    }

    const last = pageRows[pageRows.length - 1];
    const nextAfterTimeseriesId = Number(last.timeseries_id);
    const nextAfterTimestampHourUtc = String(last.timestamp_hour_utc);
    const cursorUnchanged = nextAfterTimeseriesId === cursorAfterTimeseriesId
      && nextAfterTimestampHourUtc === cursorAfterTimestampHourUtc;
    if (cursorUnchanged) {
      throw new Error(
        `AQI source RPC cursor did not advance for day=${dayUtc} connector=${connectorId}`,
      );
    }
    cursorAfterTimeseriesId = nextAfterTimeseriesId;
    cursorAfterTimestampHourUtc = nextAfterTimestampHourUtc;
  }

  if (pendingRows.length > 0) {
    await flushPart();
  }

  if (observedRows !== expectedRowCount) {
    throw new Error(
      `AQI row count mismatch for day=${dayUtc} connector=${connectorId}: expected=${expectedRowCount.toString()} observed=${observedRows.toString()}`,
    );
  }

  const connectorManifestKey = buildConnectorManifestKey(runtime.aqilevels_prefix, dayUtc, connectorId);
  const connectorManifest = createAqilevelConnectorManifest({
    dayUtc,
    connectorId,
    runId: runtime.run_id,
    sourceRowCount: Number(observedRows),
    minTimeseriesId: connector.min_timeseries_id ?? null,
    maxTimeseriesId: connector.max_timeseries_id ?? null,
    minTimestampHourUtc: minTimestampHourUtc || connector.min_timestamp_hour_utc || null,
    maxTimestampHourUtc: maxTimestampHourUtc || connector.max_timestamp_hour_utc || null,
    fileEntries,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc: nowIso(),
  });
  await r2PutObject({
    r2: runtime.r2,
    key: connectorManifestKey,
    body: Buffer.from(JSON.stringify(connectorManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: connectorManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`AQI connector manifest missing after upload: ${connectorManifestKey}`);
  }

  return {
    connector_id: connectorId,
    manifest_key: connectorManifestKey,
    source_row_count: observedRows,
    file_count: fileEntries.length,
    total_bytes: totalBytes,
    connector_manifest: {
      ...connectorManifest,
      manifest_key: connectorManifestKey,
    },
  };
}

async function exportAqilevelDayToR2({ runtime, dayUtc }) {
  const connectorCounts = await fetchAqilevelConnectorCounts(runtime, dayUtc);
  if (connectorCounts.length === 0) {
    return {
      status: "skipped_no_source_rows",
      day_utc: dayUtc,
      connector_count: 0,
      source_row_count: 0n,
      file_count: 0,
      total_bytes: 0n,
      day_manifest_key: null,
    };
  }

  const connectorManifests = [];
  let totalRows = 0n;
  let totalBytes = 0n;
  let totalFiles = 0;

  for (const connector of connectorCounts) {
    const result = await exportAqilevelConnectorDayToR2({
      runtime,
      dayUtc,
      connector,
    });
    totalRows += result.source_row_count;
    totalBytes += result.total_bytes;
    totalFiles += result.file_count;
    connectorManifests.push(result.connector_manifest);
  }

  const dayManifestKey = buildDayManifestKey(runtime.aqilevels_prefix, dayUtc);
  const dayManifest = createAqilevelDayManifest({
    dayUtc,
    runId: runtime.run_id,
    connectorManifests,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc: nowIso(),
  });
  await r2PutObject({
    r2: runtime.r2,
    key: dayManifestKey,
    body: Buffer.from(JSON.stringify(dayManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const dayHead = await r2HeadObject({ r2: runtime.r2, key: dayManifestKey });
  if (!dayHead.exists) {
    throw new Error(`AQI day manifest missing after upload: ${dayManifestKey}`);
  }

  return {
    status: "complete",
    day_utc: dayUtc,
    connector_count: connectorCounts.length,
    source_row_count: totalRows,
    file_count: totalFiles,
    total_bytes: totalBytes,
    day_manifest_key: dayManifestKey,
  };
}

async function runAqilevelsBackup({ runtime, latestEligibleDayUtc, dryRun, logStructured }) {
  const summary = {
    enabled: true,
    dry_run: dryRun,
    latest_eligible_day_utc: latestEligibleDayUtc,
    pending_days: 0,
    completed_days: 0,
    skipped_days_no_source_rows: 0,
    failed_days: 0,
    total_written_rows: "0",
    total_written_bytes: "0",
    pending_preview: [],
    completed_preview: [],
    failures: [],
  };

  logStructured("INFO", "phase_b_aqilevels_run_start", {
    run_id: runtime.run_id,
    dry_run: dryRun,
    latest_eligible_day_utc: latestEligibleDayUtc,
    max_candidates_per_run: runtime.max_candidates_per_run,
    aqilevels_prefix: runtime.aqilevels_prefix,
    aqilevels_rpc_schema: runtime.aqilevels_source?.rpc_schema || null,
    aqilevels_rows_rpc: runtime.aqilevels_source?.rows_rpc || null,
    aqilevels_connector_counts_rpc: runtime.aqilevels_source?.connector_counts_rpc || null,
  });

  if (!hasAqilevelSourceConfig(runtime)) {
    throw new Error("Phase B AQI export requires OBS_AQIDB_SUPABASE_URL and OBS_AQIDB_SECRET_KEY with AQI history RPCs.");
  }

  const pendingDays = await withPgClient(runtime.supabase_db_url, async (client) => {
    return await discoverPendingAqilevelDays({
      client,
      runtime,
      latestEligibleDayUtc,
    });
  });

  summary.pending_days = pendingDays.length;
  summary.pending_preview = pendingDays.slice(0, 25);
  if (dryRun) {
    summary.completed_preview = summary.completed_preview.slice(0, 25);
    summary.failures = summary.failures.slice(0, 25);
    logStructured("INFO", "phase_b_aqilevels_run_summary", {
      run_id: runtime.run_id,
      ...summary,
    });
    return summary;
  }

  let totalRows = 0n;
  let totalBytes = 0n;
  for (const dayUtc of pendingDays) {
    const startedAtMs = Date.now();
    try {
      const dayResult = await exportAqilevelDayToR2({
        runtime,
        dayUtc,
      });

      if (dayResult.status === "skipped_no_source_rows") {
        summary.skipped_days_no_source_rows += 1;
        logStructured("INFO", "phase_b_aqilevels_day_skipped_no_source_rows", {
          run_id: runtime.run_id,
          day_utc: dayUtc,
        });
        continue;
      }

      summary.completed_days += 1;
      totalRows += dayResult.source_row_count;
      totalBytes += dayResult.total_bytes;
      summary.completed_preview.push({
        day_utc: dayUtc,
        connector_count: dayResult.connector_count,
        source_row_count: dayResult.source_row_count.toString(),
        file_count: dayResult.file_count,
        total_bytes: dayResult.total_bytes.toString(),
        day_manifest_key: dayResult.day_manifest_key,
      });
      logStructured("INFO", "phase_b_aqilevels_day_complete", {
        run_id: runtime.run_id,
        day_utc: dayUtc,
        connector_count: dayResult.connector_count,
        source_row_count: dayResult.source_row_count.toString(),
        file_count: dayResult.file_count,
        total_bytes: dayResult.total_bytes.toString(),
        day_manifest_key: dayResult.day_manifest_key,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed_days += 1;
      summary.failures.push({
        day_utc: dayUtc,
        error: message,
        next_action: "retry_safe",
      });
      logStructured("ERROR", "phase_b_aqilevels_day_failed", {
        run_id: runtime.run_id,
        day_utc: dayUtc,
        error: message,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        next_action: "retry_safe",
      });
    }
  }

  summary.total_written_rows = totalRows.toString();
  summary.total_written_bytes = totalBytes.toString();

  summary.completed_preview = summary.completed_preview.slice(0, 25);
  summary.failures = summary.failures.slice(0, 25);
  logStructured("INFO", "phase_b_aqilevels_run_summary", {
    run_id: runtime.run_id,
    ...summary,
  });
  return summary;
}

async function finalizeDayGateIfReady({ client, runtime, dayUtc }) {
  const dayCandidates = await fetchDayCandidates(client, dayUtc);
  const dayState = computeDayGateState(dayCandidates);

  if (!dayState.all_complete) {
    await updateDayGateBlocked(client, dayUtc);
    return {
      day_utc: dayUtc,
      history_done: false,
      pending_connectors: dayState.pending + dayState.in_progress + dayState.failed,
    };
  }

  const connectorManifests = [];
  for (const candidate of dayCandidates) {
    if (!candidate.manifest_key) {
      throw new Error(`Missing connector manifest_key for day=${dayUtc} connector=${candidate.connector_id}`);
    }
    const object = await r2GetObject({ r2: runtime.r2, key: candidate.manifest_key });
    const parsed = JSON.parse(object.body.toString("utf8"));
    connectorManifests.push({
      ...parsed,
      manifest_key: candidate.manifest_key,
    });
  }

  const backedUpAtUtc = nowIso();
  const dayManifest = createDayManifest({
    dayUtc,
    runId: runtime.run_id,
    connectorManifests,
    writerGitSha: runtime.writer_git_sha,
    backedUpAtUtc,
  });
  const dayManifestKey = buildDayManifestKey(runtime.committed_prefix, dayUtc);

  await r2PutObject({
    r2: runtime.r2,
    key: dayManifestKey,
    body: Buffer.from(JSON.stringify(dayManifest, null, 2), "utf8"),
    content_type: "application/json",
  });

  const manifestHead = await r2HeadObject({ r2: runtime.r2, key: dayManifestKey });
  if (!manifestHead.exists) {
    throw new Error(`Day manifest missing after upload: ${dayManifestKey}`);
  }

  const totalRows = dayCandidates.reduce(
    (sum, row) => sum + (row.history_row_count || 0n),
    0n,
  );
  const totalFiles = dayCandidates.reduce(
    (sum, row) => sum + Number(row.history_file_count || 0),
    0,
  );
  const totalBytes = dayCandidates.reduce(
    (sum, row) => sum + (row.history_total_bytes || 0n),
    0n,
  );

  await updateDayGateComplete(client, {
    dayUtc,
    runId: runtime.run_id,
    manifestKey: dayManifestKey,
    rowCount: totalRows,
    fileCount: totalFiles,
    totalBytes,
  });

  return {
    day_utc: dayUtc,
    history_done: true,
    pending_connectors: 0,
    history_manifest_key: dayManifestKey,
    history_row_count: totalRows.toString(),
    history_file_count: totalFiles,
    history_total_bytes: totalBytes.toString(),
  };
}

async function cleanupStaging({ runtime, logStructured }) {
  const thresholdMs = (Date.now() - (runtime.staging_retention_days * DAY_MS));
  const entries = await r2ListAllObjects({
    r2: runtime.r2,
    prefix: `${runtime.staging_prefix_base}/`,
    max_keys: 1000,
  });

  const staleKeys = entries
    .filter((entry) => {
      if (!entry.last_modified) {
        return false;
      }
      const lastModifiedMs = Date.parse(entry.last_modified);
      if (Number.isNaN(lastModifiedMs)) {
        return false;
      }
      return lastModifiedMs < thresholdMs;
    })
    .map((entry) => entry.key);

  if (!staleKeys.length) {
    return {
      scanned_count: entries.length,
      deleted_count: 0,
      error_count: 0,
    };
  }

  let deletedCount = 0;
  let errorCount = 0;
  for (let i = 0; i < staleKeys.length; i += 1000) {
    const batch = staleKeys.slice(i, i + 1000);
    const result = await r2DeleteObjects({ r2: runtime.r2, keys: batch });
    deletedCount += result.deleted_count;
    errorCount += result.errors.length;
    if (result.errors.length > 0) {
      logStructured("WARNING", "phase_b_history_staging_cleanup_batch_errors", {
        run_id: runtime.run_id,
        batch_size: batch.length,
        error_count: result.errors.length,
        errors_sample: result.errors.slice(0, 10),
      });
    }
  }

  return {
    scanned_count: entries.length,
    deleted_count: deletedCount,
    error_count: errorCount,
  };
}

async function writeRunManifest({ runtime, runSummary }) {
  const key = buildRunManifestKey(runtime.runs_prefix, runtime.run_id);
  const payloadWithoutHash = {
    run_id: runtime.run_id,
    backed_up_at_utc: nowIso(),
    summary: runSummary,
  };
  const payload = withManifestHash(payloadWithoutHash);

  await r2PutObject({
    r2: runtime.r2,
    key,
    body: Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
    content_type: "application/json",
  });

  const head = await r2HeadObject({ r2: runtime.r2, key });
  if (!head.exists) {
    throw new Error(`Run manifest missing after upload: ${key}`);
  }

  return key;
}

export function dayWindowFromNow(
  nowUtcIso,
  ingestRetentionDays = DEFAULT_INGESTDB_RETENTION_DAYS,
) {
  const now = new Date(nowUtcIso);
  const todayUtc = toIsoDateUtc(new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  )));
  // Phase B must finish one full UTC day earlier than the prune cutoff day.
  const retentionDays = parsePositiveInt(
    ingestRetentionDays,
    DEFAULT_INGESTDB_RETENTION_DAYS,
    1,
    3650,
  );
  const phaseBEligibleAgeDays = retentionDays + 1;
  const latestEligibleDayUtc = shiftIsoDay(todayUtc, -phaseBEligibleAgeDays);
  const latestEligibleWindowEndIso = `${shiftIsoDay(latestEligibleDayUtc, 1)}T00:00:00.000Z`;
  return {
    now_utc: now.toISOString(),
    today_utc: todayUtc,
    ingest_retention_days: retentionDays,
    phase_b_eligible_age_days: phaseBEligibleAgeDays,
    latest_eligible_day_utc: latestEligibleDayUtc,
    latest_eligible_window_end_utc: latestEligibleWindowEndIso,
  };
}

function resolveR2Bucket(env, deployEnv) {
  const explicitBucket = (env.R2_BUCKET || env.CFLARE_R2_BUCKET || "").trim();
  if (explicitBucket) {
    return explicitBucket;
  }

  const normalized = String(deployEnv || "dev").trim().toLowerCase();
  if (normalized === "prod" || normalized === "production") {
    return (env.R2_BUCKET_PROD || "").trim();
  }
  if (normalized === "stage" || normalized === "staging") {
    return (env.R2_BUCKET_STAGE || "").trim();
  }
  return (env.R2_BUCKET_DEV || "").trim();
}

export function resolvePhaseBRuntimeConfig(env = process.env) {
  const deployEnv = String(env.UK_AQ_DEPLOY_ENV || env.DEPLOY_ENV || "dev").trim().toLowerCase() || "dev";
  const stagingBasePrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_STAGING_PREFIX || DEFAULT_STAGING_PREFIX,
  );
  const committedPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || DEFAULT_COMMITTED_PREFIX,
  );
  const aqilevelsPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || DEFAULT_AQILEVELS_PREFIX,
  );
  const runsPrefix = normalizePrefix(
    env.UK_AQ_R2_HISTORY_RUNS_PREFIX || DEFAULT_RUNS_PREFIX,
  );
  const sharedPartMaxRows = parsePositiveInt(
    env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
    DEFAULT_PART_MAX_ROWS,
    1,
    5_000_000,
  );
  const sharedRowGroupSize = parsePositiveInt(
    env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
    DEFAULT_ROW_GROUP_SIZE,
    10_000,
    2_000_000,
  );

  return {
    deploy_env: deployEnv,
    enabled: String(env.UK_AQ_R2_HISTORY_PHASE_B_ENABLED || "true").trim().toLowerCase() !== "false",
    supabase_db_url: String(env.SUPABASE_DB_URL || env.DATABASE_URL || "").trim(),
    r2: {
      endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
      bucket: resolveR2Bucket(env, deployEnv),
      region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
      access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
      secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
    },
    part_max_rows: sharedPartMaxRows,
    cursor_fetch_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_CURSOR_FETCH_ROWS,
      DEFAULT_CURSOR_FETCH_ROWS,
      1_000,
      500_000,
    ),
    row_group_size: sharedRowGroupSize,
    observations_part_max_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_PART_MAX_ROWS || env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
      DEFAULT_OBSERVATIONS_PART_MAX_ROWS,
      1,
      5_000_000,
    ),
    observations_row_group_size: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_OBSERVATIONS_ROW_GROUP_SIZE || env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
      DEFAULT_OBSERVATIONS_ROW_GROUP_SIZE,
      10_000,
      2_000_000,
    ),
    aqilevels_part_max_rows: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_PART_MAX_ROWS || env.UK_AQ_R2_HISTORY_PART_MAX_ROWS,
      DEFAULT_AQILEVELS_PART_MAX_ROWS,
      1,
      5_000_000,
    ),
    aqilevels_row_group_size: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_ROW_GROUP_SIZE || env.UK_AQ_R2_HISTORY_ROW_GROUP_SIZE,
      DEFAULT_AQILEVELS_ROW_GROUP_SIZE,
      10_000,
      2_000_000,
    ),
    aqilevels_source_max_pages: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_AQILEVELS_SOURCE_MAX_PAGES,
      DEFAULT_AQILEVELS_SOURCE_MAX_PAGES,
      10,
      1_000_000,
    ),
    max_candidates_per_run: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN,
      DEFAULT_MAX_CANDIDATES_PER_RUN,
      1,
      50_000,
    ),
    staging_retention_days: parsePositiveInt(
      env.UK_AQ_R2_HISTORY_STAGING_RETENTION_DAYS,
      DEFAULT_STAGING_RETENTION_DAYS,
      1,
      90,
    ),
    staging_prefix_base: stagingBasePrefix,
    committed_prefix: committedPrefix,
    aqilevels_prefix: aqilevelsPrefix,
    runs_prefix: runsPrefix,
    aqilevels_source: {
      base_url: String(env.OBS_AQIDB_SUPABASE_URL || "").trim(),
      privileged_key: String(env.OBS_AQIDB_SECRET_KEY || "").trim(),
      rpc_schema: String(env.UK_AQ_PUBLIC_SCHEMA || DEFAULT_RPC_SCHEMA).trim() || DEFAULT_RPC_SCHEMA,
      connector_counts_rpc: String(env.UK_AQ_BACKFILL_AQI_R2_CONNECTOR_COUNTS_RPC || AQILEVELS_CONNECTOR_COUNTS_RPC)
        .trim(),
      rows_rpc: String(env.UK_AQ_BACKFILL_AQI_R2_SOURCE_RPC || AQILEVELS_ROWS_RPC).trim(),
    },
    writer_git_sha: String(env.GITHUB_SHA || "").trim() || null,
  };
}

export async function runPhaseBBackup({
  dryRun,
  phaseB,
  ingestRetentionDays = DEFAULT_INGESTDB_RETENTION_DAYS,
  logStructured,
  runId = randomUUID(),
  nowUtc = nowIso(),
}) {
  const runtime = {
    ...phaseB,
    run_id: runId,
    staging_prefix: `${phaseB.staging_prefix_base}/run_id=${runId}`,
  };

  if (!runtime.enabled) {
    return {
      enabled: false,
      run_id: runId,
      reason: "phase_b_disabled",
    };
  }

  if (!runtime.supabase_db_url) {
    throw new Error("Phase B history export requires SUPABASE_DB_URL (or DATABASE_URL) for streaming Postgres extraction.");
  }
  if (!hasRequiredR2Config(runtime.r2)) {
    throw new Error("Phase B history export requires R2 endpoint/bucket/region/access credentials.");
  }

  const window = dayWindowFromNow(nowUtc, ingestRetentionDays);
  const summary = {
    enabled: true,
    run_id: runId,
    now_utc: window.now_utc,
    ingest_retention_days: window.ingest_retention_days,
    phase_b_eligible_age_days: window.phase_b_eligible_age_days,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
    latest_eligible_window_end_utc: window.latest_eligible_window_end_utc,
    dry_run: dryRun,
    populated_candidates: 0,
    pending_candidates: 0,
    processed_candidates: 0,
    completed_candidates: 0,
    failed_candidates: 0,
    total_written_rows: "0",
    total_written_bytes: "0",
    completed_days: 0,
    blocked_days: 0,
    failures: [],
    completed_preview: [],
    blocked_preview: [],
    aqilevels: null,
  };

  logStructured("INFO", "phase_b_history_run_start", {
    run_id: runId,
    dry_run: dryRun,
    now_utc: window.now_utc,
    ingest_retention_days: window.ingest_retention_days,
    phase_b_eligible_age_days: window.phase_b_eligible_age_days,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
    max_candidates_per_run: runtime.max_candidates_per_run,
    part_max_rows: runtime.part_max_rows,
    observations_part_max_rows: runtime.observations_part_max_rows,
    aqilevels_part_max_rows: runtime.aqilevels_part_max_rows,
    cursor_fetch_rows: runtime.cursor_fetch_rows,
    row_group_size: runtime.row_group_size,
    observations_row_group_size: runtime.observations_row_group_size,
    aqilevels_row_group_size: runtime.aqilevels_row_group_size,
    deploy_env: runtime.deploy_env,
    r2_bucket: runtime.r2.bucket,
    observations_prefix: runtime.committed_prefix,
    aqilevels_prefix: runtime.aqilevels_prefix,
  });

  const dayResults = new Map();
  let totalWrittenRows = 0n;
  let totalWrittenBytes = 0n;

  await withPgClient(runtime.supabase_db_url, async (controlClient) => {
    const upsertedCandidates = await populateBackupCandidates(controlClient, window.latest_eligible_window_end_utc);
    summary.populated_candidates = upsertedCandidates.length;

    await markIncompleteDaysAsBackupBlocked(controlClient);

    const pendingCandidates = await fetchPendingCandidates(controlClient, runtime.max_candidates_per_run);
    summary.pending_candidates = pendingCandidates.length;

    if (dryRun) {
      const planned = pendingCandidates.map((candidate) => ({
        day_utc: candidate.day_utc,
        connector_id: candidate.connector_id,
        expected_row_count: candidate.expected_row_count.toString(),
        resume_part_index: Number(candidate.resume_part_index || 0),
        resume_exported_row_count: candidate.resume_exported_row_count.toString(),
        planned_committed_prefix: connectorPrefix(runtime.committed_prefix, candidate.day_utc, candidate.connector_id),
        planned_manifest_key: buildConnectorManifestKey(
          runtime.committed_prefix,
          candidate.day_utc,
          candidate.connector_id,
        ),
      }));

      summary.completed_preview = planned.slice(0, 25);
      summary.blocked_days = uniqueSorted(pendingCandidates.map((candidate) => candidate.day_utc)).length;

      logStructured("INFO", "phase_b_history_dry_run_plan", {
        run_id: runId,
        pending_candidates: pendingCandidates.length,
        planned_preview: planned.slice(0, 25),
      });
      return;
    }

    for (const candidate of pendingCandidates) {
      summary.processed_candidates += 1;

      const claimed = await markCandidateInProgress(controlClient, candidate.day_utc, candidate.connector_id, runId);
      if (!claimed) {
        continue;
      }

      const startedAtMs = Date.now();
      try {
        const exportResult = await exportCandidateToR2({
          candidate,
          runtime,
        });

        await markCandidateComplete(controlClient, {
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          runId,
          manifestKey: exportResult.manifest_key,
          historyRowCount: exportResult.written_row_count,
          historyFileCount: exportResult.file_count,
          historyTotalBytes: exportResult.total_bytes,
        });

        totalWrittenRows += exportResult.written_row_count;
        totalWrittenBytes += exportResult.total_bytes;
        summary.completed_candidates += 1;

        const dayState = await finalizeDayGateIfReady({
          client: controlClient,
          runtime,
          dayUtc: candidate.day_utc,
        });
        dayResults.set(candidate.day_utc, dayState);

        const durationMs = Math.max(0, Date.now() - startedAtMs);
        logStructured("INFO", "phase_b_history_candidate_complete", {
          run_id: runId,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          resumed_from_part_index: Number(candidate.resume_part_index || 0),
          resumed_from_row_count: candidate.resume_exported_row_count.toString(),
          expected_row_count: candidate.expected_row_count.toString(),
          written_row_count: exportResult.written_row_count.toString(),
          file_count: exportResult.file_count,
          total_bytes: exportResult.total_bytes.toString(),
          manifest_key: exportResult.manifest_key,
          duration_ms: durationMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markCandidateFailed(controlClient, {
          dayUtc: candidate.day_utc,
          connectorId: candidate.connector_id,
          runId,
          errorText: message,
        });
        const dayState = await finalizeDayGateIfReady({
          client: controlClient,
          runtime,
          dayUtc: candidate.day_utc,
        });
        dayResults.set(candidate.day_utc, dayState);
        summary.failed_candidates += 1;
        summary.failures.push({
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          run_id: runId,
          error: message,
          next_action: "retry_safe",
        });
        logStructured("ERROR", "phase_b_history_candidate_failed", {
          run_id: runId,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          resumed_from_part_index: Number(candidate.resume_part_index || 0),
          resumed_from_row_count: candidate.resume_exported_row_count.toString(),
          error: message,
          next_action: "retry_safe",
          prune_blocked_for_day: true,
        });
      }
    }
  });

  summary.aqilevels = await runAqilevelsBackup({
    runtime,
    latestEligibleDayUtc: window.latest_eligible_day_utc,
    dryRun,
    logStructured,
  });

  if (dryRun) {
    logStructured("INFO", "phase_b_history_run_summary", summary);
    return summary;
  }

  summary.total_written_rows = totalWrittenRows.toString();
  summary.total_written_bytes = totalWrittenBytes.toString();

  const dayStates = Array.from(dayResults.values());
  summary.completed_days = dayStates.filter((state) => state.history_done === true).length;
  summary.blocked_days = dayStates.filter((state) => state.history_done !== true).length;
  summary.completed_preview = dayStates.slice(0, 25);
  summary.blocked_preview = dayStates.filter((state) => state.history_done !== true).slice(0, 25);

  const cleanupSummary = await cleanupStaging({ runtime, logStructured });
  summary.staging_cleanup = cleanupSummary;

  const runManifestKey = await writeRunManifest({ runtime, runSummary: summary });
  summary.run_manifest_key = runManifestKey;

  logStructured("INFO", "phase_b_history_run_summary", summary);
  return summary;
}

export async function fetchBackupDoneDays({ supabaseDbUrl, dayUtcList }) {
  if (!Array.isArray(dayUtcList) || dayUtcList.length === 0) {
    return new Map();
  }

  const distinctDays = uniqueSorted(dayUtcList.map((day) => String(day).slice(0, 10)));
  if (distinctDays.length === 0) {
    return new Map();
  }

  return await withPgClient(supabaseDbUrl, async (client) => {
    const literalList = distinctDays.map((day) => `'${escapeSingleQuotes(day)}'::date`).join(", ");
    const sql = `
select g.day_utc::text as day_utc
from uk_aq_ops.prune_day_gates g
where g.day_utc in (${literalList})
  and g.history_done is true
  and nullif(btrim(g.history_manifest_key), '') is not null
  and g.history_manifest_key ~ '^history/v1/(observations|aqilevels)/day_utc=[0-9]{4}-[0-9]{2}-[0-9]{2}/manifest\\.json$'
  and g.history_completed_at is not null
`;
    const result = await client.query(sql);
    const map = new Map();
    for (const row of result.rows) {
      map.set(normalizeDayUtc(row.day_utc), true);
    }
    return map;
  });
}
