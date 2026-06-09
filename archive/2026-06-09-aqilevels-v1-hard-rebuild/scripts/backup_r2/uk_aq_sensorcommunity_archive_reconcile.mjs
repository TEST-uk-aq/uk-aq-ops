#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const DEFAULT_CONNECTOR_ID = 7;
const DEFAULT_ARCHIVE_BASE_URL = (
  process.env.UK_AQ_BACKFILL_SCOMM_ARCHIVE_BASE_URL ||
  "https://archive.sensor.community"
).trim().replace(/\/+$/, "");
const DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT =
  "/Users/mikehinford/Library/CloudStorage/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_history_backup";
const DEFAULT_MIRROR_ROOT = String(
  process.env.UK_AQ_BACKFILL_SCOMM_RAW_MIRROR_ROOT || "",
).trim();
const DEFAULT_INCLUDE_MET_FIELDS = parseBooleanish(
  process.env.UK_AQ_BACKFILL_SCOMM_INCLUDE_MET_FIELDS,
  true,
);
const DEFAULT_TIMEOUT_MS = parsePositiveInt(
  process.env.UK_AQ_BACKFILL_SCOMM_ARCHIVE_TIMEOUT_MS,
  120_000,
);
const DEFAULT_RETRIES = parsePositiveInt(
  process.env.UK_AQ_BACKFILL_SCOMM_ARCHIVE_FETCH_RETRIES,
  3,
);
const DEFAULT_RETRY_BASE_MS = parsePositiveInt(
  process.env.UK_AQ_BACKFILL_SCOMM_ARCHIVE_RETRY_BASE_MS,
  1_500,
);
const DEFAULT_SAMPLE_LIMIT = 20;
const HISTORY_ROOT = "history/v1";
const KEY_SEPARATOR = "\u001f";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_sensorcommunity_archive_reconcile.mjs --day YYYY-MM-DD [options]",
    "",
    "Purpose:",
    "  Compare Sensor.Community archive CSV rows to local observations history parquet rows",
    "  using the same station/pollutant mapping rules as the Sensor.Community backfill.",
    "",
    "Options:",
    "  --day <YYYY-MM-DD>          Required UTC day to reconcile",
    "  --core-day <YYYY-MM-DD>     Core snapshot day to use (default: latest local core day)",
    "  --dropbox-root <path>       Local R2 history Dropbox root",
    "                              (default: auto detect, usually CIC-Test/R2_history_backup)",
    "  --mirror-root <path>        Optional local Sensor.Community raw mirror root",
    "                              (path layout: day_utc=YYYY-MM-DD/<archive file>)",
    "  --archive-base-url <url>    Sensor.Community archive base URL",
    `                              (default: ${DEFAULT_ARCHIVE_BASE_URL})`,
    `  --connector-id <n>          Connector id (default: ${DEFAULT_CONNECTOR_ID})`,
    "  --station-ref <ref>         Optional station_ref filter; can be repeated",
    `  --include-met-fields <bool> Include temperature/humidity/pressure (default: ${String(DEFAULT_INCLUDE_MET_FIELDS)})`,
    `  --timeout-ms <n>            Archive fetch timeout per request (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --retries <n>               Archive fetch attempts (default: ${DEFAULT_RETRIES})`,
    `  --retry-base-ms <n>         Archive fetch retry base delay (default: ${DEFAULT_RETRY_BASE_MS})`,
    "  --format text|json          Output format (default: text)",
    `  --sample-limit <n>          Mismatch sample count per side (default: ${DEFAULT_SAMPLE_LIMIT})`,
    "  --out <path>                Write output to file as well as stdout",
    "  -h, --help                  Show this help",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    day: "",
    coreDay: "",
    dropboxRoot: "",
    mirrorRoot: DEFAULT_MIRROR_ROOT,
    archiveBaseUrl: DEFAULT_ARCHIVE_BASE_URL,
    connectorId: DEFAULT_CONNECTOR_ID,
    stationRefs: [],
    includeMetFields: DEFAULT_INCLUDE_MET_FIELDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
    format: "text",
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
    outPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--day") {
      args.day = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--core-day") {
      args.coreDay = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--dropbox-root") {
      args.dropboxRoot = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--mirror-root") {
      args.mirrorRoot = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--archive-base-url") {
      args.archiveBaseUrl = String(argv[index + 1] || "")
        .trim()
        .replace(/\/+$/, "");
      index += 1;
      continue;
    }
    if (arg === "--connector-id") {
      args.connectorId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--station-ref") {
      const stationRef = String(argv[index + 1] || "").trim();
      if (stationRef) {
        args.stationRefs.push(stationRef);
      }
      index += 1;
      continue;
    }
    if (arg === "--include-met-fields") {
      args.includeMetFields = parseBooleanish(argv[index + 1], true);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--retries") {
      args.retries = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--retry-base-ms") {
      args.retryBaseMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--format") {
      args.format = String(argv[index + 1] || "").trim().toLowerCase();
      index += 1;
      continue;
    }
    if (arg === "--sample-limit") {
      args.sampleLimit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      args.outPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!isIsoDay(args.day)) {
    throw new Error("--day is required and must be YYYY-MM-DD");
  }
  if (args.coreDay && !isIsoDay(args.coreDay)) {
    throw new Error("--core-day must be YYYY-MM-DD");
  }
  if (!Number.isInteger(args.connectorId) || args.connectorId <= 0) {
    throw new Error("--connector-id must be a positive integer");
  }
  if (!new Set(["text", "json"]).has(args.format)) {
    throw new Error("--format must be text or json");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  if (!Number.isFinite(args.retries) || args.retries < 1) {
    throw new Error("--retries must be a positive integer");
  }
  if (!Number.isFinite(args.retryBaseMs) || args.retryBaseMs < 0) {
    throw new Error("--retry-base-ms must be zero or positive");
  }
  if (!Number.isFinite(args.sampleLimit) || args.sampleLimit < 0) {
    throw new Error("--sample-limit must be zero or positive");
  }

  args.retries = Math.trunc(args.retries);
  args.sampleLimit = Math.trunc(args.sampleLimit);
  args.stationRefs = Array.from(new Set(args.stationRefs)).sort((left, right) =>
    left.localeCompare(right)
  );

  return args;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseBooleanish(raw, fallback) {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (new Set(["1", "true", "t", "yes", "y", "on"]).has(value)) {
    return true;
  }
  if (new Set(["0", "false", "f", "no", "n", "off"]).has(value)) {
    return false;
  }
  return fallback;
}

function isIsoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT || "").trim(),
    DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return "";
}

function listIsoDayDirectories(domainDir) {
  const out = [];
  if (!fs.existsSync(domainDir)) {
    return out;
  }
  for (const entry of fs.readdirSync(domainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = entry.name.match(/^day_utc=(\d{4}-\d{2}-\d{2})$/);
    if (match) {
      out.push(match[1]);
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function findLatestCoreDay(dropboxRoot) {
  const coreDomainDir = path.join(dropboxRoot, HISTORY_ROOT, "core");
  const days = listIsoDayDirectories(coreDomainDir);
  return days.length ? days[days.length - 1] : "";
}

function loadNdjsonGzRows(filePath) {
  const compressed = fs.readFileSync(filePath);
  const text = zlib.gunzipSync(compressed).toString("utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    rows.push(JSON.parse(line));
  }
  return rows;
}

function stationPollutantKey(stationRef, pollutantCode) {
  return `${stationRef}|${pollutantCode}`;
}

function parseSourcePollutantCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
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
  if (compact === "humidity" || compact === "relativehumidity" || compact === "rh") {
    return "humidity";
  }
  if (compact === "pressure" || compact === "airpressure") return "pressure";
  return null;
}

function parseTimeseriesRefBinding(record) {
  const timeseriesId = Number(record.id);
  const timeseriesRef = String(record.timeseries_ref || "").trim();
  if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !timeseriesRef) {
    return null;
  }
  const separator = timeseriesRef.lastIndexOf(":");
  if (separator <= 0 || separator === timeseriesRef.length - 1) {
    return null;
  }
  const stationRef = timeseriesRef.slice(0, separator).trim();
  const pollutantCode = parseSourcePollutantCode(timeseriesRef.slice(separator + 1));
  if (!stationRef || !pollutantCode) {
    return null;
  }
  return {
    timeseries_id: timeseriesId,
    station_ref: stationRef,
    pollutant_code: pollutantCode,
    timeseries_ref: timeseriesRef,
  };
}

function loadTimeseriesLookup({ dropboxRoot, coreDay, connectorId, stationRefs }) {
  const filePath = path.join(
    dropboxRoot,
    HISTORY_ROOT,
    "core",
    `day_utc=${coreDay}`,
    "table=timeseries",
    "rows.ndjson.gz",
  );
  if (!fs.existsSync(filePath)) {
    throw new Error(`Core timeseries snapshot not found: ${filePath}`);
  }

  const stationFilter = stationRefs.length ? new Set(stationRefs) : null;
  const bindingByStationPollutant = new Map();
  const bindingByTimeseriesId = new Map();
  const stationRefSet = new Set();
  const ignoredRows = [];
  const pollutantCounts = new Map();

  for (const row of loadNdjsonGzRows(filePath)) {
    if (Number(row.connector_id) !== connectorId) {
      continue;
    }
    const binding = parseTimeseriesRefBinding(row);
    if (!binding) {
      ignoredRows.push({
        id: row?.id ?? null,
        timeseries_ref: row?.timeseries_ref ?? null,
      });
      continue;
    }
    if (stationFilter && !stationFilter.has(binding.station_ref)) {
      continue;
    }
    stationRefSet.add(binding.station_ref);
    bindingByTimeseriesId.set(binding.timeseries_id, binding);
    const key = stationPollutantKey(binding.station_ref, binding.pollutant_code);
    const existing = bindingByStationPollutant.get(key);
    if (!existing || binding.timeseries_id < existing.timeseries_id) {
      bindingByStationPollutant.set(key, binding);
    }
  }

  for (const binding of bindingByStationPollutant.values()) {
    pollutantCounts.set(
      binding.pollutant_code,
      (pollutantCounts.get(binding.pollutant_code) || 0) + 1,
    );
  }

  return {
    filePath,
    station_refs: stationRefSet,
    binding_by_station_pollutant: bindingByStationPollutant,
    binding_by_timeseries_id: bindingByTimeseriesId,
    ignored_rows: ignoredRows,
    binding_counts_by_pollutant: Object.fromEntries(
      Array.from(pollutantCounts.entries()).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  };
}

async function fetchTextWithRetry(url, timeoutMs, retries, retryBaseMs) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "uk-aq-ops-archive-reconcile" },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(retryBaseMs * (2 ** (attempt - 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseSensorcommunityStationRefFromFilename(fileName) {
  const match = String(fileName || "").match(/_sensor_([0-9]+)\.csv$/i);
  return match ? match[1] : null;
}

function buildMirrorDayDir(mirrorRoot, day) {
  if (!mirrorRoot) {
    return "";
  }
  return path.join(mirrorRoot, `day_utc=${day}`);
}

async function listArchiveFiles({
  day,
  archiveBaseUrl,
  mirrorRoot,
  stationRefs,
  timeoutMs,
  retries,
  retryBaseMs,
}) {
  const stationFilter = stationRefs.size ? stationRefs : null;
  const mirrorDayDir = buildMirrorDayDir(mirrorRoot, day);
  if (mirrorDayDir && fs.existsSync(mirrorDayDir) && fs.statSync(mirrorDayDir).isDirectory()) {
    const files = fs.readdirSync(mirrorDayDir)
      .filter((entry) => entry.endsWith(".csv") && entry.startsWith(`${day}_`) && entry.includes("_sensor_"))
      .filter((fileName) => {
        if (!stationFilter) {
          return true;
        }
        const stationRef = parseSensorcommunityStationRefFromFilename(fileName);
        return Boolean(stationRef && stationFilter.has(stationRef));
      })
      .sort((left, right) => left.localeCompare(right));
    return {
      source: "local_mirror",
      files,
      total_files_listed: files.length,
      mirror_day_dir: mirrorDayDir,
    };
  }

  const indexUrl = `${archiveBaseUrl}/${day}/`;
  const html = await fetchTextWithRetry(indexUrl, timeoutMs, retries, retryBaseMs);
  const allFiles = new Set();
  const pattern = /href="([^"]+\.csv)"/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const fileName = match[1].trim();
    if (!fileName.startsWith(`${day}_`) || !fileName.includes("_sensor_")) {
      continue;
    }
    allFiles.add(fileName);
  }
  const filteredFiles = Array.from(allFiles)
    .filter((fileName) => {
      if (!stationFilter) {
        return true;
      }
      const stationRef = parseSensorcommunityStationRefFromFilename(fileName);
      return Boolean(stationRef && stationFilter.has(stationRef));
    })
    .sort((left, right) => left.localeCompare(right));

  return {
    source: "remote_index",
    files: filteredFiles,
    total_files_listed: allFiles.size,
    mirror_day_dir: mirrorDayDir || null,
  };
}

async function fetchArchiveCsv({
  day,
  fileName,
  archiveBaseUrl,
  mirrorRoot,
  timeoutMs,
  retries,
  retryBaseMs,
}) {
  const mirrorDayDir = buildMirrorDayDir(mirrorRoot, day);
  const mirrorPath = mirrorDayDir ? path.join(mirrorDayDir, fileName) : "";
  if (mirrorPath && fs.existsSync(mirrorPath)) {
    return {
      csvText: fs.readFileSync(mirrorPath, "utf8"),
      source: "local_mirror",
      mirror_path: mirrorPath,
    };
  }

  const url = `${archiveBaseUrl}/${day}/${fileName}`;
  return {
    csvText: await fetchTextWithRetry(url, timeoutMs, retries, retryBaseMs),
    source: "remote_file",
    mirror_path: mirrorPath || null,
  };
}

function parseCsvNumber(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (new Set(["nan", "null", "none", "na"]).has(normalized)) {
    return null;
  }
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseArchiveTimestampToIso(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  const hasTimezone = /z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value);
  const target = hasTimezone ? value : `${value}Z`;
  const parsedMs = Date.parse(target);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

function toCanonicalValueString(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (Object.is(numeric, -0)) {
    return "0";
  }
  return numeric.toString();
}

function buildComparisonKey(timeseriesRef, observedAtIso, canonicalValue) {
  return `${timeseriesRef}${KEY_SEPARATOR}${observedAtIso}${KEY_SEPARATOR}${canonicalValue}`;
}

function decodeComparisonKey(key) {
  const [timeseriesRef, observedAt, value] = String(key || "").split(KEY_SEPARATOR);
  const separator = timeseriesRef.lastIndexOf(":");
  const stationRef = separator > 0 ? timeseriesRef.slice(0, separator) : null;
  const pollutantCode = separator > 0 ? timeseriesRef.slice(separator + 1) : null;
  return {
    timeseries_ref: timeseriesRef,
    station_ref: stationRef,
    pollutant_code: pollutantCode,
    observed_at: observedAt,
    value,
  };
}

function incrementCount(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

function parseArchiveCsvIntoCounts({
  day,
  fileName,
  csvText,
  lookup,
  includeMetFields,
  keyCounts,
}) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const summary = {
    file_name: fileName,
    station_ref: parseSensorcommunityStationRefFromFilename(fileName),
    csv_record_count: Math.max(0, lines.length - 1),
    mapped_row_count: 0,
    skipped_unknown_station_ref: 0,
    skipped_invalid_timestamp: 0,
    skipped_outside_day: 0,
    skipped_missing_binding: 0,
    skipped_missing_column: 0,
    skipped_invalid_value: 0,
    rows_by_pollutant: {},
  };
  if (lines.length <= 1) {
    return summary;
  }

  const headers = lines[0].split(";").map((header) => header.trim());
  const headerIndex = new Map();
  headers.forEach((header, index) => {
    headerIndex.set(header.toLowerCase(), index);
  });
  const sensorIdIndex = headerIndex.get("sensor_id");
  const timestampIndex = headerIndex.get("timestamp");
  if (sensorIdIndex === undefined || timestampIndex === undefined) {
    return summary;
  }

  const mappings = [
    { header: "p1", pollutant_code: "pm10" },
    { header: "p2", pollutant_code: "pm25" },
  ];
  if (includeMetFields) {
    mappings.push(
      { header: "temperature", pollutant_code: "temperature" },
      { header: "humidity", pollutant_code: "humidity" },
      { header: "pressure", pollutant_code: "pressure" },
    );
  }

  const dayStartIso = `${day}T00:00:00.000Z`;
  const nextDayMs = Date.parse(dayStartIso) + (24 * 60 * 60 * 1000);
  const dayEndIso = new Date(nextDayMs).toISOString();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const columns = lines[lineIndex].split(";");
    const stationRef = String(columns[sensorIdIndex] || "").trim();
    if (!stationRef || !lookup.station_refs.has(stationRef)) {
      summary.skipped_unknown_station_ref += 1;
      continue;
    }

    const observedAtIso = parseArchiveTimestampToIso(columns[timestampIndex] || "");
    if (!observedAtIso) {
      summary.skipped_invalid_timestamp += 1;
      continue;
    }
    if (observedAtIso < dayStartIso || observedAtIso >= dayEndIso) {
      summary.skipped_outside_day += 1;
      continue;
    }

    for (const mapping of mappings) {
      const valueIndex = headerIndex.get(mapping.header);
      if (valueIndex === undefined) {
        summary.skipped_missing_column += 1;
        continue;
      }
      const binding = lookup.binding_by_station_pollutant.get(
        stationPollutantKey(stationRef, mapping.pollutant_code),
      );
      if (!binding) {
        summary.skipped_missing_binding += 1;
        continue;
      }
      const value = parseCsvNumber(columns[valueIndex] || "");
      if (value === null) {
        summary.skipped_invalid_value += 1;
        continue;
      }
      const canonicalValue = toCanonicalValueString(value);
      if (canonicalValue === null) {
        summary.skipped_invalid_value += 1;
        continue;
      }
      const key = buildComparisonKey(binding.timeseries_ref, observedAtIso, canonicalValue);
      incrementCount(keyCounts, key);
      summary.mapped_row_count += 1;
      summary.rows_by_pollutant[mapping.pollutant_code] =
        (summary.rows_by_pollutant[mapping.pollutant_code] || 0) + 1;
    }
  }

  return summary;
}

async function loadObservationCounts({
  dropboxRoot,
  day,
  connectorId,
  lookup,
}) {
  const connectorDir = path.join(
    dropboxRoot,
    HISTORY_ROOT,
    "observations",
    `day_utc=${day}`,
    `connector_id=${connectorId}`,
  );
  if (!fs.existsSync(connectorDir) || !fs.statSync(connectorDir).isDirectory()) {
    throw new Error(`Observations history directory not found: ${connectorDir}`);
  }
  const parquetFiles = fs.readdirSync(connectorDir)
    .filter((entry) => entry.endsWith(".parquet"))
    .sort((left, right) => left.localeCompare(right));
  if (!parquetFiles.length) {
    throw new Error(`No parquet files found under: ${connectorDir}`);
  }

  const keyCounts = new Map();
  const unknownTimeseriesCounts = new Map();
  const pollutantCounts = new Map();
  let observationRowCount = 0;

  for (const fileName of parquetFiles) {
    const filePath = path.join(connectorDir, fileName);
    const fileBuffer = fs.readFileSync(filePath);
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength,
    );
    const rows = await parquetReadObjects({
      file: arrayBuffer,
      compressors,
    });

    for (const row of rows) {
      observationRowCount += 1;
      const binding = lookup.binding_by_timeseries_id.get(Number(row.timeseries_id));
      if (!binding) {
        incrementCount(unknownTimeseriesCounts, String(row.timeseries_id));
        continue;
      }
      const observedAtIso = new Date(row.observed_at).toISOString();
      const canonicalValue = toCanonicalValueString(row.value);
      if (canonicalValue === null) {
        continue;
      }
      const key = buildComparisonKey(binding.timeseries_ref, observedAtIso, canonicalValue);
      incrementCount(keyCounts, key);
      incrementCount(pollutantCounts, binding.pollutant_code);
    }
  }

  return {
    connector_dir: connectorDir,
    parquet_files: parquetFiles,
    key_counts: keyCounts,
    observation_row_count: observationRowCount,
    mapped_observation_row_count: Array.from(keyCounts.values()).reduce((sum, count) => sum + count, 0),
    unknown_timeseries_ids: Object.fromEntries(
      Array.from(unknownTimeseriesCounts.entries())
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 50),
    ),
    unknown_timeseries_row_count: Array.from(unknownTimeseriesCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    ),
    rows_by_pollutant: Object.fromEntries(
      Array.from(pollutantCounts.entries()).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  };
}

function recordAggregate(aggregateMap, decodedRow, delta) {
  if (!decodedRow.station_ref || !decodedRow.pollutant_code) {
    return;
  }
  const pollutant = decodedRow.pollutant_code;
  const stationRef = decodedRow.station_ref;
  aggregateMap.by_pollutant[pollutant] =
    (aggregateMap.by_pollutant[pollutant] || 0) + delta;
  aggregateMap.by_station_ref[stationRef] =
    (aggregateMap.by_station_ref[stationRef] || 0) + delta;
}

function sortObjectByValueDesc(input, limit = null) {
  const entries = Object.entries(input || {})
    .sort((left, right) => {
      const delta = Number(right[1]) - Number(left[1]);
      if (delta !== 0) {
        return delta;
      }
      return String(left[0]).localeCompare(String(right[0]));
    });
  return Object.fromEntries(limit == null ? entries : entries.slice(0, limit));
}

function compareKeyCounts(archiveKeyCounts, observationKeyCounts, sampleLimit) {
  const mismatchKeys = new Set();
  const diff = {
    exact_match: true,
    matching_row_count: 0,
    missing_in_observations_row_count: 0,
    unexpected_in_observations_row_count: 0,
    mismatch_key_count: 0,
    missing_in_observations: {
      by_pollutant: {},
      by_station_ref: {},
      samples: [],
    },
    unexpected_in_observations: {
      by_pollutant: {},
      by_station_ref: {},
      samples: [],
    },
  };

  for (const [key, archiveCount] of archiveKeyCounts.entries()) {
    const observationCount = observationKeyCounts.get(key) || 0;
    diff.matching_row_count += Math.min(archiveCount, observationCount);
    if (archiveCount > observationCount) {
      const delta = archiveCount - observationCount;
      diff.exact_match = false;
      mismatchKeys.add(key);
      diff.missing_in_observations_row_count += delta;
      const decoded = decodeComparisonKey(key);
      recordAggregate(diff.missing_in_observations, decoded, delta);
      if (diff.missing_in_observations.samples.length < sampleLimit) {
        diff.missing_in_observations.samples.push({
          ...decoded,
          archive_count: archiveCount,
          observation_count: observationCount,
          difference: delta,
        });
      }
    }
  }

  for (const [key, observationCount] of observationKeyCounts.entries()) {
    const archiveCount = archiveKeyCounts.get(key) || 0;
    if (observationCount > archiveCount) {
      const delta = observationCount - archiveCount;
      diff.exact_match = false;
      mismatchKeys.add(key);
      diff.unexpected_in_observations_row_count += delta;
      const decoded = decodeComparisonKey(key);
      recordAggregate(diff.unexpected_in_observations, decoded, delta);
      if (diff.unexpected_in_observations.samples.length < sampleLimit) {
        diff.unexpected_in_observations.samples.push({
          ...decoded,
          archive_count: archiveCount,
          observation_count: observationCount,
          difference: delta,
        });
      }
    }
  }

  diff.missing_in_observations.by_pollutant = sortObjectByValueDesc(
    diff.missing_in_observations.by_pollutant,
  );
  diff.missing_in_observations.by_station_ref = sortObjectByValueDesc(
    diff.missing_in_observations.by_station_ref,
    20,
  );
  diff.unexpected_in_observations.by_pollutant = sortObjectByValueDesc(
    diff.unexpected_in_observations.by_pollutant,
  );
  diff.unexpected_in_observations.by_station_ref = sortObjectByValueDesc(
    diff.unexpected_in_observations.by_station_ref,
    20,
  );
  diff.mismatch_key_count = mismatchKeys.size;
  return diff;
}

function formatTextReport(report) {
  const lines = [];
  lines.push(`Sensor.Community archive reconciliation: ${report.day_utc}`);
  lines.push(`exact_match: ${String(report.comparison.exact_match)}`);
  lines.push(`core_day: ${report.core_day}`);
  lines.push(`dropbox_root: ${report.dropbox_root}`);
  lines.push(`connector_id: ${report.connector_id}`);
  if (report.station_refs_requested.length) {
    lines.push(`station_refs_requested: ${report.station_refs_requested.join(", ")}`);
  }
  lines.push("");
  lines.push("Archive:");
  lines.push(`  file_source: ${report.archive.file_source}`);
  lines.push(`  relevant_files: ${report.archive.relevant_file_count}`);
  lines.push(`  total_files_listed: ${report.archive.total_files_listed}`);
  lines.push(`  csv_records: ${report.archive.csv_record_count}`);
  lines.push(`  mapped_rows: ${report.archive.mapped_row_count}`);
  lines.push("");
  lines.push("Observations history:");
  lines.push(`  parquet_files: ${report.observations.parquet_files.length}`);
  lines.push(`  rows_total: ${report.observations.observation_row_count}`);
  lines.push(`  rows_mapped_to_core: ${report.observations.mapped_observation_row_count}`);
  lines.push(`  rows_unknown_timeseries: ${report.observations.unknown_timeseries_row_count}`);
  lines.push("");
  lines.push("Comparison:");
  lines.push(`  matching_rows: ${report.comparison.matching_row_count}`);
  lines.push(`  missing_in_observations: ${report.comparison.missing_in_observations_row_count}`);
  lines.push(`  unexpected_in_observations: ${report.comparison.unexpected_in_observations_row_count}`);
  lines.push(`  mismatch_keys: ${report.comparison.mismatch_key_count}`);
  if (report.comparison.missing_in_observations.samples.length) {
    lines.push("");
    lines.push("Missing sample:");
    for (const sample of report.comparison.missing_in_observations.samples) {
      lines.push(
        `  ${sample.timeseries_ref} @ ${sample.observed_at} value=${sample.value} diff=${sample.difference}`,
      );
    }
  }
  if (report.comparison.unexpected_in_observations.samples.length) {
    lines.push("");
    lines.push("Unexpected sample:");
    for (const sample of report.comparison.unexpected_in_observations.samples) {
      lines.push(
        `  ${sample.timeseries_ref} @ ${sample.observed_at} value=${sample.value} diff=${sample.difference}`,
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dropboxRoot = findDropboxRoot(args.dropboxRoot);
  if (!dropboxRoot) {
    throw new Error("Could not find local Dropbox R2 history backup root");
  }

  const coreDay = args.coreDay || findLatestCoreDay(dropboxRoot);
  if (!coreDay) {
    throw new Error("Could not resolve a local core snapshot day");
  }

  const lookup = loadTimeseriesLookup({
    dropboxRoot,
    coreDay,
    connectorId: args.connectorId,
    stationRefs: args.stationRefs,
  });
  if (!lookup.station_refs.size) {
    throw new Error(
      `No Sensor.Community timeseries bindings found for connector_id=${args.connectorId}`,
    );
  }

  const archiveListing = await listArchiveFiles({
    day: args.day,
    archiveBaseUrl: args.archiveBaseUrl,
    mirrorRoot: args.mirrorRoot,
    stationRefs: lookup.station_refs,
    timeoutMs: args.timeoutMs,
    retries: args.retries,
    retryBaseMs: args.retryBaseMs,
  });
  if (!archiveListing.files.length) {
    throw new Error(`No relevant Sensor.Community archive files found for ${args.day}`);
  }

  const archiveKeyCounts = new Map();
  const archiveFileSummaries = [];
  let archiveCsvRecordCount = 0;
  let archiveMappedRowCount = 0;

  for (const fileName of archiveListing.files) {
    const { csvText } = await fetchArchiveCsv({
      day: args.day,
      fileName,
      archiveBaseUrl: args.archiveBaseUrl,
      mirrorRoot: args.mirrorRoot,
      timeoutMs: args.timeoutMs,
      retries: args.retries,
      retryBaseMs: args.retryBaseMs,
    });
    const summary = parseArchiveCsvIntoCounts({
      day: args.day,
      fileName,
      csvText,
      lookup,
      includeMetFields: args.includeMetFields,
      keyCounts: archiveKeyCounts,
    });
    archiveCsvRecordCount += summary.csv_record_count;
    archiveMappedRowCount += summary.mapped_row_count;
    archiveFileSummaries.push(summary);
  }

  const observations = await loadObservationCounts({
    dropboxRoot,
    day: args.day,
    connectorId: args.connectorId,
    lookup,
  });
  const comparison = compareKeyCounts(
    archiveKeyCounts,
    observations.key_counts,
    args.sampleLimit,
  );

  const report = {
    generated_at_utc: new Date().toISOString(),
    day_utc: args.day,
    core_day: coreDay,
    connector_id: args.connectorId,
    dropbox_root: dropboxRoot,
    station_refs_requested: args.stationRefs,
    include_met_fields: args.includeMetFields,
    lookup: {
      station_ref_count: lookup.station_refs.size,
      binding_count: lookup.binding_by_station_pollutant.size,
      binding_counts_by_pollutant: lookup.binding_counts_by_pollutant,
      ignored_timeseries_rows_count: lookup.ignored_rows.length,
      ignored_timeseries_rows_sample: lookup.ignored_rows.slice(0, 10),
    },
    archive: {
      archive_base_url: args.archiveBaseUrl,
      mirror_root: args.mirrorRoot || null,
      file_source: archiveListing.source,
      total_files_listed: archiveListing.total_files_listed,
      relevant_file_count: archiveListing.files.length,
      relevant_station_ref_count: Array.from(
        new Set(
          archiveListing.files
            .map((fileName) => parseSensorcommunityStationRefFromFilename(fileName))
            .filter(Boolean),
        ),
      ).length,
      csv_record_count: archiveCsvRecordCount,
      mapped_row_count: archiveMappedRowCount,
      top_files_by_csv_records: archiveFileSummaries
        .slice()
        .sort((left, right) => right.csv_record_count - left.csv_record_count)
        .slice(0, 20),
    },
    observations: {
      connector_dir: observations.connector_dir,
      parquet_files: observations.parquet_files,
      observation_row_count: observations.observation_row_count,
      mapped_observation_row_count: observations.mapped_observation_row_count,
      unknown_timeseries_row_count: observations.unknown_timeseries_row_count,
      unknown_timeseries_ids: observations.unknown_timeseries_ids,
      rows_by_pollutant: observations.rows_by_pollutant,
    },
    comparison,
  };

  const output = args.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatTextReport(report)}\n`;

  process.stdout.write(output);
  if (args.outPath) {
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, output, "utf8");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
