#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import zlib from "node:zlib";
import { Client } from "pg";
import Cursor from "pg-cursor";
import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_CORE_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_CORE_PREFIX || "history/v1/core",
);
const DEFAULT_SOURCE_SCHEMA = (process.env.UK_AQ_CORE_SNAPSHOT_SCHEMA || "uk_aq_core").trim();
const DEFAULT_CURSOR_BATCH_ROWS = parsePositiveInt(process.env.UK_AQ_R2_CORE_SNAPSHOT_CURSOR_BATCH_ROWS, 5000);
const DEFAULT_REPORT_OUT = String(process.env.UK_AQ_R2_CORE_SNAPSHOT_REPORT_OUT || "").trim();

const TABLE_EXPORT_CONFIG = Object.freeze({
  connectors: Object.freeze({ order_by: "id" }),
  categories: Object.freeze({ order_by: "id" }),
  observed_properties: Object.freeze({ order_by: "id" }),
  phenomena: Object.freeze({ order_by: "id" }),
  offerings: Object.freeze({ order_by: "id" }),
  features: Object.freeze({ order_by: "id" }),
  procedures: Object.freeze({ order_by: "id" }),
  uk_aq_networks: Object.freeze({ order_by: "id" }),
  uk_air_sos_networks: Object.freeze({ order_by: "network_ref" }),
  uk_air_sos_network_pollutants: Object.freeze({ order_by: "network_ref, match_type, match_value" }),
  stations: Object.freeze({ order_by: "id" }),
  station_metadata: Object.freeze({ order_by: "station_id" }),
  station_network_memberships: Object.freeze({ order_by: "station_id, network_code" }),
  timeseries: Object.freeze({ order_by: "id" }),
});

const DEFAULT_TABLES = Object.freeze([
  "connectors",
  "categories",
  "observed_properties",
  "phenomena",
  "offerings",
  "features",
  "procedures",
  "uk_aq_networks",
  "uk_air_sos_networks",
  "uk_air_sos_network_pollutants",
  "stations",
  "station_metadata",
  "station_network_memberships",
  "timeseries",
]);

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs [options]",
      "",
      "Required env:",
      "  UK_AQ_INGEST_DATABASE_URL or SUPABASE_DB_URL",
      "  CFLARE_R2_ENDPOINT",
      "  CFLARE_R2_BUCKET",
      "  CFLARE_R2_REGION (optional, default auto)",
      "  CFLARE_R2_ACCESS_KEY_ID",
      "  CFLARE_R2_SECRET_ACCESS_KEY",
      "",
      "Optional:",
      "  --day-utc <YYYY-MM-DD>       Default: today UTC",
      "  --prefix <r2-prefix>         Default: history/v1/core",
      "  --table <name>               Repeatable table filter",
      "  --tables <a,b,c>             Comma-separated table filter",
      "  --cursor-batch-rows <N>      Default: 5000",
      "  --report-out <file>          Write JSON report to file",
      "  --dry-run                    Build snapshot + manifest only, no R2 writes",
      "  -h, --help",
    ].join("\n"),
  );
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

function parseIsoDayOrThrow(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid day_utc (expected YYYY-MM-DD): ${value}`);
  }
  return value;
}

function todayUtcDay() {
  return new Date().toISOString().slice(0, 10);
}

function assertSimpleSqlIdent(value, label) {
  const ident = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid ${label}: ${ident}`);
  }
  return ident;
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) {
    return;
  }
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {
    day_utc: todayUtcDay(),
    prefix: DEFAULT_CORE_PREFIX,
    tables: [],
    cursor_batch_rows: DEFAULT_CURSOR_BATCH_ROWS,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--day-utc") {
      args.day_utc = parseIsoDayOrThrow(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix = normalizePrefix(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--table") {
      const table = String(argv[i + 1] || "").trim();
      if (!table) {
        throw new Error("--table requires a value");
      }
      args.tables.push(table);
      i += 1;
      continue;
    }
    if (arg === "--tables") {
      const values = String(argv[i + 1] || "").split(",").map((v) => v.trim()).filter(Boolean);
      args.tables.push(...values);
      i += 1;
      continue;
    }
    if (arg === "--cursor-batch-rows") {
      args.cursor_batch_rows = parsePositiveInt(argv[i + 1], Number.NaN);
      if (!Number.isFinite(args.cursor_batch_rows)) {
        throw new Error("--cursor-batch-rows must be a positive integer");
      }
      i += 1;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.prefix) {
    throw new Error("--prefix resolved to an empty value");
  }

  const requestedTables = args.tables.length ? Array.from(new Set(args.tables)) : [...DEFAULT_TABLES];
  const unknown = requestedTables.filter((name) => !TABLE_EXPORT_CONFIG[name]);
  if (unknown.length) {
    throw new Error(`Unknown table(s): ${unknown.join(", ")}`);
  }
  args.tables = requestedTables;

  return args;
}

function buildR2Config() {
  return {
    endpoint: String(process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    bucket: String(process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
    region: String(process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(
      process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "",
    ).trim(),
  };
}

function getIngestDbUrl() {
  return String(process.env.UK_AQ_INGEST_DATABASE_URL || process.env.SUPABASE_DB_URL || "").trim();
}

async function withPgClient(connectionString, fn) {
  const client = new Client({
    connectionString,
    statement_timeout: 0,
    query_timeout: 0,
    application_name: "uk_aq_core_snapshot_to_r2",
  });
  await client.connect();
  try {
    await client.query("set timezone = 'UTC'");
    return await fn(client);
  } finally {
    await client.end();
  }
}

function readCursor(cursor, rowCount) {
  return new Promise((resolve, reject) => {
    cursor.read(rowCount, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function closeCursor(cursor) {
  return new Promise((resolve, reject) => {
    cursor.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function writeLine(stream, text) {
  if (stream.write(text, "utf8")) {
    return;
  }
  await once(stream, "drain");
}

function waitForStreamFinish(stream) {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function exportTableToGzip({
  client,
  schema,
  table,
  orderBy,
  outputFile,
  cursorBatchRows,
}) {
  const sql = `
select row_to_json(source_row)::text as row_json
from (
  select *
  from ${schema}.${table}
  order by ${orderBy}
) as source_row
`;

  const cursor = client.query(new Cursor(sql));
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
  const outStream = fs.createWriteStream(outputFile);
  gzip.pipe(outStream);

  const uncompressedHash = createHash("sha256");
  let rowCount = 0;
  let uncompressedBytes = 0;

  try {
    for (;;) {
      const rows = await readCursor(cursor, cursorBatchRows);
      if (!rows.length) {
        break;
      }

      for (const row of rows) {
        const rowJson = typeof row.row_json === "string" ? row.row_json : JSON.stringify(row.row_json || {});
        const line = `${rowJson}\n`;
        rowCount += 1;
        uncompressedBytes += Buffer.byteLength(line);
        uncompressedHash.update(line);
        await writeLine(gzip, line);
      }
    }

    gzip.end();
    await waitForStreamFinish(outStream);
  } finally {
    await closeCursor(cursor).catch(() => {});
  }

  const compressedBytes = fs.statSync(outputFile).size;
  const compressedBuffer = fs.readFileSync(outputFile);

  return {
    row_count: rowCount,
    uncompressed_bytes: uncompressedBytes,
    compressed_bytes: compressedBytes,
    sha256_uncompressed: uncompressedHash.digest("hex"),
    sha256: sha256Hex(compressedBuffer),
  };
}

async function fetchExistingManifestHash(r2, manifestKey) {
  const head = await r2HeadObject({ r2, key: manifestKey });
  if (!head.exists) {
    return null;
  }

  const object = await r2GetObject({ r2, key: manifestKey });
  const manifestText = object.body.toString("utf8");

  try {
    const parsed = JSON.parse(manifestText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.manifest_hash === "string") {
      return parsed.manifest_hash.trim() || null;
    }
  } catch {
    // Ignore parse failure and treat as changed.
  }

  return null;
}

async function main(args) {
  const startedAt = new Date().toISOString();
  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: null,
    dry_run: args.dry_run,
    day_utc: args.day_utc,
    prefix: args.prefix,
    source_schema: DEFAULT_SOURCE_SCHEMA,
    source_tables: args.tables,
    existing_manifest_hash: null,
    new_manifest_hash: null,
    manifest_changed: null,
    uploaded_objects: 0,
    uploaded_bytes: 0,
    skipped_write_reason: null,
    manifest_key: `${args.prefix}/day_utc=${args.day_utc}/manifest.json`,
    checksums_key: `${args.prefix}/day_utc=${args.day_utc}/checksums.sha256`,
    table_exports: [],
  };

  const ingestDbUrl = getIngestDbUrl();
  if (!ingestDbUrl) {
    throw new Error("Missing UK_AQ_INGEST_DATABASE_URL (or SUPABASE_DB_URL)");
  }
  const sourceSchema = assertSimpleSqlIdent(DEFAULT_SOURCE_SCHEMA, "UK_AQ_CORE_SNAPSHOT_SCHEMA");
  report.source_schema = sourceSchema;

  const r2 = buildR2Config();
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing required R2 configuration (CFLARE_R2_* / R2_*)");
  }

  const dayPrefix = `${args.prefix}/day_utc=${args.day_utc}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uk_aq_core_snapshot_"));

  try {
    const tableArtifacts = await withPgClient(ingestDbUrl, async (client) => {
      const artifacts = [];
      for (const table of args.tables) {
        const config = TABLE_EXPORT_CONFIG[table];
        const relativePath = `table=${table}/rows.ndjson.gz`;
        const tempFile = path.join(tmpDir, `${table}.rows.ndjson.gz`);
        const result = await exportTableToGzip({
          client,
          schema: sourceSchema,
          table,
          orderBy: config.order_by,
          outputFile: tempFile,
          cursorBatchRows: args.cursor_batch_rows,
        });

        artifacts.push({
          table,
          order_by: config.order_by,
          relative_path: relativePath,
          key: `${dayPrefix}/${relativePath}`,
          temp_file: tempFile,
          ...result,
        });
      }
      return artifacts;
    });

    const checksumsLines = tableArtifacts
      .map((entry) => `${entry.sha256}  ${entry.relative_path}`)
      .join("\n");
    const checksumsPayload = checksumsLines ? `${checksumsLines}\n` : "";
    const checksumsSha = sha256Hex(checksumsPayload);

    const manifestWithoutHash = {
      schema_name: "uk_aq_core_snapshot",
      schema_version: 1,
      generated_at_utc: new Date().toISOString(),
      day_utc: args.day_utc,
      source_schema: sourceSchema,
      prefix: args.prefix,
      file_format: "ndjson.gz",
      tables: tableArtifacts.map((entry) => ({
        table: entry.table,
        order_by: entry.order_by,
        key: entry.key,
        relative_path: entry.relative_path,
        row_count: entry.row_count,
        uncompressed_bytes: entry.uncompressed_bytes,
        compressed_bytes: entry.compressed_bytes,
        sha256: entry.sha256,
        sha256_uncompressed: entry.sha256_uncompressed,
      })),
      totals: {
        table_count: tableArtifacts.length,
        total_rows: tableArtifacts.reduce((sum, entry) => sum + entry.row_count, 0),
        total_uncompressed_bytes: tableArtifacts.reduce((sum, entry) => sum + entry.uncompressed_bytes, 0),
        total_compressed_bytes: tableArtifacts.reduce((sum, entry) => sum + entry.compressed_bytes, 0),
      },
      checksums: {
        key: report.checksums_key,
        algorithm: "sha256",
        sha256: checksumsSha,
      },
    };

    const manifestHash = sha256Hex(JSON.stringify(manifestWithoutHash));
    const manifest = {
      ...manifestWithoutHash,
      manifest_hash: manifestHash,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

    report.existing_manifest_hash = await fetchExistingManifestHash(r2, report.manifest_key);
    report.new_manifest_hash = manifestHash;
    report.manifest_changed = report.existing_manifest_hash !== manifestHash;

    report.table_exports = tableArtifacts.map((entry) => ({
      table: entry.table,
      key: entry.key,
      relative_path: entry.relative_path,
      row_count: entry.row_count,
      uncompressed_bytes: entry.uncompressed_bytes,
      compressed_bytes: entry.compressed_bytes,
      sha256: entry.sha256,
      sha256_uncompressed: entry.sha256_uncompressed,
    }));

    if (!args.dry_run && report.manifest_changed) {
      for (const entry of tableArtifacts) {
        const body = fs.readFileSync(entry.temp_file);
        await r2PutObject({
          r2,
          key: entry.key,
          body,
          content_type: "application/gzip",
        });
        report.uploaded_objects += 1;
        report.uploaded_bytes += body.byteLength;
      }

      await r2PutObject({
        r2,
        key: report.checksums_key,
        body: checksumsPayload,
        content_type: "text/plain; charset=utf-8",
      });
      report.uploaded_objects += 1;
      report.uploaded_bytes += Buffer.byteLength(checksumsPayload);

      await r2PutObject({
        r2,
        key: report.manifest_key,
        body: manifestText,
        content_type: "application/json",
      });
      report.uploaded_objects += 1;
      report.uploaded_bytes += Buffer.byteLength(manifestText);
    } else if (!args.dry_run && !report.manifest_changed) {
      report.skipped_write_reason = "manifest_unchanged";
    } else if (args.dry_run) {
      report.skipped_write_reason = "dry_run";
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  report.completed_at = new Date().toISOString();
  return report;
}

let reportOutPath = DEFAULT_REPORT_OUT;

try {
  const args = parseArgs(process.argv.slice(2));
  reportOutPath = args.report_out || reportOutPath;
  const report = await main(args);
  writeReport(reportOutPath, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    ok: false,
    error: message,
  };
  if (reportOutPath) {
    writeReport(reportOutPath, payload);
  }
  console.error(JSON.stringify(payload));
  process.exit(1);
}
