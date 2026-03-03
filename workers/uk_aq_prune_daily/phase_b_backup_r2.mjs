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
  r2CopyObject,
  r2DeleteObjects,
  r2GetObject,
  r2HeadObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../shared/r2_sigv4.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PART_MAX_ROWS = 1_000_000;
const DEFAULT_CURSOR_FETCH_ROWS = 20_000;
const DEFAULT_ROW_GROUP_SIZE = 100_000;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 500;
const DEFAULT_STAGING_RETENTION_DAYS = 7;
const DEFAULT_STAGING_PREFIX = "backup/staging";
const DEFAULT_COMMITTED_PREFIX = "backup/observations";
const DEFAULT_RUNS_PREFIX = "backup/runs";

const BACKUP_SCHEMA_NAME = "observations";
const BACKUP_SCHEMA_VERSION = 1;
const WRITER_VERSION = "parquet-wasm-zstd-v1";

export const BACKUP_OBSERVATIONS_COLUMNS_V1 = Object.freeze([
  "connector_id",
  "timeseries_id",
  "observed_at",
  "value",
  "status",
  // TODO(phase-b-v2): drop created_at and bump backup schema version to keep readers tolerant.
  "created_at",
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

function observationsSelectList(columns) {
  return columns.map((column) => `o.${column}`).join(", ");
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
    application_name: "uk_aq_prune_daily_phase_b_backup",
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
    backup_row_count: row.backup_row_count === null || row.backup_row_count === undefined
      ? null
      : parseBigInt(row.backup_row_count, "backup_row_count"),
    backup_file_count: row.backup_file_count === null || row.backup_file_count === undefined
      ? null
      : Number(row.backup_file_count),
    backup_total_bytes: row.backup_total_bytes === null || row.backup_total_bytes === undefined
      ? null
      : parseBigInt(row.backup_total_bytes, "backup_total_bytes"),
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
  left join uk_aq_ops.backup_candidates existing_complete
    on existing_complete.day_utc = (o.observed_at at time zone 'UTC')::date
   and existing_complete.connector_id = o.connector_id
   and existing_complete.status = 'complete'
  where o.observed_at < $1::timestamptz
    and existing_complete.day_utc is null
  group by 1, 2
),
upserted as (
  insert into uk_aq_ops.backup_candidates (
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    last_error,
    manifest_key,
    backup_row_count,
    backup_file_count,
    backup_total_bytes,
    backup_completed_at
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
    null
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
    backup_row_count = null,
    backup_file_count = null,
    backup_total_bytes = null,
    backup_completed_at = null,
    updated_at = now()
  where uk_aq_ops.backup_candidates.status <> 'complete'
  returning
    day_utc,
    connector_id,
    expected_row_count,
    min_observed_at,
    max_observed_at,
    status,
    run_id,
    manifest_key,
    backup_row_count,
    backup_file_count,
    backup_total_bytes
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
  from uk_aq_ops.backup_candidates c
  group by c.day_utc
)
insert into uk_aq_ops.prune_day_gates (
  day_utc,
  backup_done,
  backup_run_id,
  backup_manifest_key,
  backup_row_count,
  backup_file_count,
  backup_total_bytes,
  backup_completed_at,
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
  backup_done = false,
  backup_run_id = null,
  backup_manifest_key = null,
  backup_row_count = null,
  backup_file_count = null,
  backup_total_bytes = null,
  backup_completed_at = null,
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
  c.backup_row_count,
  c.backup_file_count,
  c.backup_total_bytes
from uk_aq_ops.backup_candidates c
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
update uk_aq_ops.backup_candidates
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
  backupRowCount,
  backupFileCount,
  backupTotalBytes,
}) {
  await client.query(
    `
update uk_aq_ops.backup_candidates
set
  status = 'complete',
  run_id = $3,
  last_error = null,
  manifest_key = $4,
  backup_row_count = $5,
  backup_file_count = $6,
  backup_total_bytes = $7,
  backup_completed_at = now(),
  updated_at = now()
where day_utc = $1::date
  and connector_id = $2::integer
`,
    [
      dayUtc,
      connectorId,
      runId,
      manifestKey,
      backupRowCount.toString(),
      backupFileCount,
      backupTotalBytes.toString(),
    ],
  );
}

async function markCandidateFailed(client, { dayUtc, connectorId, runId, errorText }) {
  await client.query(
    `
update uk_aq_ops.backup_candidates
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
  backup_row_count,
  backup_file_count,
  backup_total_bytes
from uk_aq_ops.backup_candidates
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
  backup_done,
  backup_run_id,
  backup_manifest_key,
  backup_row_count,
  backup_file_count,
  backup_total_bytes,
  backup_completed_at,
  updated_at
)
values ($1::date, false, null, null, null, null, null, null, now())
on conflict (day_utc)
do update set
  backup_done = false,
  backup_run_id = null,
  backup_manifest_key = null,
  backup_row_count = null,
  backup_file_count = null,
  backup_total_bytes = null,
  backup_completed_at = null,
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
  backup_done,
  backup_run_id,
  backup_manifest_key,
  backup_row_count,
  backup_file_count,
  backup_total_bytes,
  backup_completed_at,
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
  backup_done = true,
  backup_run_id = excluded.backup_run_id,
  backup_manifest_key = excluded.backup_manifest_key,
  backup_row_count = excluded.backup_row_count,
  backup_file_count = excluded.backup_file_count,
  backup_total_bytes = excluded.backup_total_bytes,
  backup_completed_at = now(),
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
    backup_schema_name: BACKUP_SCHEMA_NAME,
    backup_schema_version: BACKUP_SCHEMA_VERSION,
    columns: BACKUP_OBSERVATIONS_COLUMNS_V1,
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
    backup_schema_name: BACKUP_SCHEMA_NAME,
    backup_schema_version: BACKUP_SCHEMA_VERSION,
    columns: BACKUP_OBSERVATIONS_COLUMNS_V1,
    writer_version: WRITER_VERSION,
    writer_git_sha: writerGitSha,
    ...stats,
    backed_up_at_utc: backedUpAtUtc,
  });
}

const PARQUET_WRITER_PROPERTIES_CACHE = new Map();

function parquetWriterProperties(rowGroupSize) {
  const key = Number(rowGroupSize);
  if (PARQUET_WRITER_PROPERTIES_CACHE.has(key)) {
    return PARQUET_WRITER_PROPERTIES_CACHE.get(key);
  }

  ensureParquetWasmInitialized();
  const writerProperties = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(key)
    .setCreatedBy(WRITER_VERSION)
    .build();

  PARQUET_WRITER_PROPERTIES_CACHE.set(key, writerProperties);
  return writerProperties;
}

function rowsToParquetBuffer(rows, writerProperties) {
  ensureParquetWasmInitialized();
  const table = arrow.tableFromArrays({
    connector_id: Int32Array.from(rows.map((row) => Number(row.connector_id))),
    timeseries_id: Int32Array.from(rows.map((row) => Number(row.timeseries_id))),
    observed_at: rows.map((row) => new Date(row.observed_at)),
    value: rows.map((row) => (row.value === null || row.value === undefined ? null : Number(row.value))),
    status: rows.map((row) => (row.status === undefined ? null : row.status)),
    created_at: rows.map((row) => (row.created_at ? new Date(row.created_at) : null)),
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

async function exportCandidateToR2({ candidate, runtime }) {
  const dayUtc = candidate.day_utc;
  const connectorId = candidate.connector_id;
  const dayStart = `${dayUtc}T00:00:00.000Z`;
  const dayEnd = `${shiftIsoDay(dayUtc, 1)}T00:00:00.000Z`;

  const writerProperties = parquetWriterProperties(runtime.row_group_size);
  const expectedRowCount = candidate.expected_row_count;

  const stagingParts = [];
  const committedParts = [];
  let observedRows = 0n;
  let totalBytes = 0n;

  await withPgClient(runtime.supabase_db_url, async (streamClient) => {
    const sql = `
select ${observationsSelectList(BACKUP_OBSERVATIONS_COLUMNS_V1)}
from uk_aq_core.observations o
where o.connector_id = $1
  and o.observed_at >= $2::timestamptz
  and o.observed_at < $3::timestamptz
order by o.timeseries_id asc, o.observed_at asc
`;

    const cursor = streamClient.query(new Cursor(sql, [connectorId, dayStart, dayEnd]));
    let partIndex = 0;
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
            status: row.status,
            created_at: row.created_at,
          });

          if (pendingRows.length >= runtime.part_max_rows) {
            const parquetBuffer = rowsToParquetBuffer(pendingRows, writerProperties);
            const stagingKey = buildPartKey(runtime.staging_prefix, dayUtc, connectorId, partIndex);
            const committedKey = buildPartKey(runtime.committed_prefix, dayUtc, connectorId, partIndex);
            const putResult = await r2PutObject({
              r2: runtime.r2,
              key: stagingKey,
              body: parquetBuffer,
              content_type: "application/octet-stream",
            });
            stagingParts.push({
              key: stagingKey,
              row_count: pendingRows.length,
              bytes: putResult.bytes,
              etag_or_hash: putResult.etag || null,
            });
            committedParts.push({
              key: committedKey,
              row_count: pendingRows.length,
              bytes: putResult.bytes,
              etag_or_hash: putResult.etag || null,
            });
            observedRows += BigInt(pendingRows.length);
            totalBytes += BigInt(putResult.bytes);
            partIndex += 1;
            pendingRows = [];
          }
        }
      }

      if (pendingRows.length > 0) {
        const parquetBuffer = rowsToParquetBuffer(pendingRows, writerProperties);
        const stagingKey = buildPartKey(runtime.staging_prefix, dayUtc, connectorId, partIndex);
        const committedKey = buildPartKey(runtime.committed_prefix, dayUtc, connectorId, partIndex);
        const putResult = await r2PutObject({
          r2: runtime.r2,
          key: stagingKey,
          body: parquetBuffer,
          content_type: "application/octet-stream",
        });
        stagingParts.push({
          key: stagingKey,
          row_count: pendingRows.length,
          bytes: putResult.bytes,
          etag_or_hash: putResult.etag || null,
        });
        committedParts.push({
          key: committedKey,
          row_count: pendingRows.length,
          bytes: putResult.bytes,
          etag_or_hash: putResult.etag || null,
        });
        observedRows += BigInt(pendingRows.length);
        totalBytes += BigInt(putResult.bytes);
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

  for (const part of stagingParts) {
    const head = await r2HeadObject({ r2: runtime.r2, key: part.key });
    if (!head.exists) {
      throw new Error(`Missing staged object: ${part.key}`);
    }
  }

  for (let index = 0; index < stagingParts.length; index += 1) {
    const staged = stagingParts[index];
    const committed = committedParts[index];
    await r2CopyObject({
      r2: runtime.r2,
      source_key: staged.key,
      dest_key: committed.key,
    });
  }

  for (const part of committedParts) {
    const head = await r2HeadObject({ r2: runtime.r2, key: part.key });
    if (!head.exists) {
      throw new Error(`Missing committed object: ${part.key}`);
    }
    part.etag_or_hash = head.etag || part.etag_or_hash || null;
    if (typeof head.bytes === "number" && Number.isFinite(head.bytes)) {
      part.bytes = head.bytes;
    }
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

async function finalizeDayGateIfReady({ client, runtime, dayUtc }) {
  const dayCandidates = await fetchDayCandidates(client, dayUtc);
  const dayState = computeDayGateState(dayCandidates);

  if (!dayState.all_complete) {
    await updateDayGateBlocked(client, dayUtc);
    return {
      day_utc: dayUtc,
      backup_done: false,
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
    (sum, row) => sum + (row.backup_row_count || 0n),
    0n,
  );
  const totalFiles = dayCandidates.reduce(
    (sum, row) => sum + Number(row.backup_file_count || 0),
    0,
  );
  const totalBytes = dayCandidates.reduce(
    (sum, row) => sum + (row.backup_total_bytes || 0n),
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
    backup_done: true,
    pending_connectors: 0,
    backup_manifest_key: dayManifestKey,
    backup_row_count: totalRows.toString(),
    backup_file_count: totalFiles,
    backup_total_bytes: totalBytes.toString(),
  };
}

async function cleanupStaging({ runtime, logStructured }) {
  const thresholdMs = (Date.now() - (runtime.staging_retention_days * DAY_MS));
  const entries = await r2ListAllObjects({
    r2: runtime.r2,
    prefix: `${runtime.staging_prefix}/`,
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
      logStructured("WARNING", "phase_b_backup_staging_cleanup_batch_errors", {
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

function dayWindowFromNow(nowUtcIso) {
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
  const latestEligibleDayUtc = shiftIsoDay(todayUtc, -8);
  const latestEligibleWindowEndIso = `${shiftIsoDay(latestEligibleDayUtc, 1)}T00:00:00.000Z`;
  return {
    now_utc: now.toISOString(),
    today_utc: todayUtc,
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
  const stagingBasePrefix = normalizePrefix(env.BACKUP_STAGING_PREFIX || DEFAULT_STAGING_PREFIX);
  const committedPrefix = normalizePrefix(env.BACKUP_COMMITTED_PREFIX || DEFAULT_COMMITTED_PREFIX);
  const runsPrefix = normalizePrefix(env.BACKUP_RUNS_PREFIX || DEFAULT_RUNS_PREFIX);

  return {
    deploy_env: deployEnv,
    enabled: String(env.BACKUP_PHASE_B_ENABLED || "true").trim().toLowerCase() !== "false",
    supabase_db_url: String(env.SUPABASE_DB_URL || env.DATABASE_URL || "").trim(),
    r2: {
      endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
      bucket: resolveR2Bucket(env, deployEnv),
      region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
      access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
      secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
    },
    part_max_rows: parsePositiveInt(env.BACKUP_PART_MAX_ROWS, DEFAULT_PART_MAX_ROWS, 1, 5_000_000),
    cursor_fetch_rows: parsePositiveInt(env.BACKUP_CURSOR_FETCH_ROWS, DEFAULT_CURSOR_FETCH_ROWS, 1_000, 500_000),
    row_group_size: parsePositiveInt(env.BACKUP_ROW_GROUP_SIZE, DEFAULT_ROW_GROUP_SIZE, 10_000, 2_000_000),
    max_candidates_per_run: parsePositiveInt(
      env.BACKUP_MAX_CANDIDATES_PER_RUN,
      DEFAULT_MAX_CANDIDATES_PER_RUN,
      1,
      50_000,
    ),
    staging_retention_days: parsePositiveInt(
      env.BACKUP_STAGING_RETENTION_DAYS,
      DEFAULT_STAGING_RETENTION_DAYS,
      1,
      90,
    ),
    staging_prefix_base: stagingBasePrefix,
    committed_prefix: committedPrefix,
    runs_prefix: runsPrefix,
    writer_git_sha: String(env.GITHUB_SHA || "").trim() || null,
  };
}

export async function runPhaseBBackup({
  dryRun,
  phaseB,
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
    throw new Error("Phase B backup requires SUPABASE_DB_URL (or DATABASE_URL) for streaming Postgres extraction.");
  }
  if (!hasRequiredR2Config(runtime.r2)) {
    throw new Error("Phase B backup requires R2 endpoint/bucket/region/access credentials.");
  }

  const window = dayWindowFromNow(nowUtc);
  const summary = {
    enabled: true,
    run_id: runId,
    now_utc: window.now_utc,
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
  };

  logStructured("INFO", "phase_b_backup_run_start", {
    run_id: runId,
    dry_run: dryRun,
    now_utc: window.now_utc,
    latest_eligible_day_utc: window.latest_eligible_day_utc,
    max_candidates_per_run: runtime.max_candidates_per_run,
    part_max_rows: runtime.part_max_rows,
    cursor_fetch_rows: runtime.cursor_fetch_rows,
    row_group_size: runtime.row_group_size,
    deploy_env: runtime.deploy_env,
    r2_bucket: runtime.r2.bucket,
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
        planned_staging_prefix: connectorPrefix(runtime.staging_prefix, candidate.day_utc, candidate.connector_id),
        planned_committed_prefix: connectorPrefix(runtime.committed_prefix, candidate.day_utc, candidate.connector_id),
        planned_manifest_key: buildConnectorManifestKey(
          runtime.committed_prefix,
          candidate.day_utc,
          candidate.connector_id,
        ),
      }));

      summary.completed_preview = planned.slice(0, 25);
      summary.blocked_days = uniqueSorted(pendingCandidates.map((candidate) => candidate.day_utc)).length;

      logStructured("INFO", "phase_b_backup_dry_run_plan", {
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
          backupRowCount: exportResult.written_row_count,
          backupFileCount: exportResult.file_count,
          backupTotalBytes: exportResult.total_bytes,
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
        logStructured("INFO", "phase_b_backup_candidate_complete", {
          run_id: runId,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
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
        logStructured("ERROR", "phase_b_backup_candidate_failed", {
          run_id: runId,
          day_utc: candidate.day_utc,
          connector_id: candidate.connector_id,
          error: message,
          next_action: "retry_safe",
          prune_blocked_for_day: true,
        });
      }
    }
  });

  if (dryRun) {
    logStructured("INFO", "phase_b_backup_run_summary", summary);
    return summary;
  }

  summary.total_written_rows = totalWrittenRows.toString();
  summary.total_written_bytes = totalWrittenBytes.toString();

  const dayStates = Array.from(dayResults.values());
  summary.completed_days = dayStates.filter((state) => state.backup_done === true).length;
  summary.blocked_days = dayStates.filter((state) => state.backup_done !== true).length;
  summary.completed_preview = dayStates.slice(0, 25);
  summary.blocked_preview = dayStates.filter((state) => state.backup_done !== true).slice(0, 25);

  const cleanupSummary = await cleanupStaging({ runtime, logStructured });
  summary.staging_cleanup = cleanupSummary;

  const runManifestKey = await writeRunManifest({ runtime, runSummary: summary });
  summary.run_manifest_key = runManifestKey;

  logStructured("INFO", "phase_b_backup_run_summary", summary);
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
select g.day_utc::text as day_utc, g.backup_done
from uk_aq_ops.prune_day_gates g
where g.day_utc in (${literalList})
`;
    const result = await client.query(sql);
    const map = new Map();
    for (const row of result.rows) {
      map.set(normalizeDayUtc(row.day_utc), Boolean(row.backup_done));
    }
    return map;
  });
}
