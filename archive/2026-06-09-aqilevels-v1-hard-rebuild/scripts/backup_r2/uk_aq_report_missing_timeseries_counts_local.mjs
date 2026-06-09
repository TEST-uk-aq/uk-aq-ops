#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function buildDefaultDropboxLocalBackupRoot() {
  const dropboxRoot = String(process.env.UK_AQ_DROPBOX_ROOT || "").trim() || "CIC-Test";
  return `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/${dropboxRoot}/R2_history_backup`;
}

const DEFAULT_DROPBOX_LOCAL_BACKUP_ROOT = buildDefaultDropboxLocalBackupRoot();
const DEFAULT_OBSERVATIONS_PREFIX = "history/v1/observations";
const DEFAULT_OBSERVATIONS_TS_INDEX_PREFIX = "history/_index/observations_timeseries";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_report_missing_timeseries_counts_local.mjs [options]",
    "",
    "Options:",
    "  --root <path>               Local R2 Dropbox backup root (default: auto detect)",
    "  --out <path>                Write output to file as well as stdout",
    "  --format csv|json           Output format (default: csv)",
    "  --from-day <YYYY-MM-DD>     Optional inclusive lower day bound",
    "  --to-day <YYYY-MM-DD>       Optional inclusive upper day bound",
    "  --connector-id <id>         Optional connector filter (repeatable)",
    "  --include-ok                Include rows that already have counts",
    "  --targets-only              Emit only day_utc,connector_id columns (CSV only)",
    "  -h, --help                  Show this help",
    "",
    "Optional env:",
    "  UK_AQ_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_ROOT",
    "  UK_AQ_R2_HISTORY_DROPBOX_LOCAL_ROOT",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX (default history/v1/observations)",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX",
    "    (default history/_index/observations_timeseries)",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    root: "",
    outPath: "",
    format: "csv",
    fromDay: "",
    toDay: "",
    connectorIds: new Set(),
    includeOk: false,
    targetsOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.outPath = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--format") {
      args.format = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--from-day") {
      args.fromDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--to-day") {
      args.toDay = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--connector-id") {
      args.connectorIds.add(parsePositiveInt(argv[i + 1], "--connector-id"));
      i += 1;
      continue;
    }
    if (arg === "--include-ok") {
      args.includeOk = true;
      continue;
    }
    if (arg === "--targets-only") {
      args.targetsOnly = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!new Set(["csv", "json"]).has(args.format)) {
    throw new Error("--format must be csv or json");
  }
  if (args.fromDay && !isIsoDay(args.fromDay)) {
    throw new Error("--from-day must be YYYY-MM-DD");
  }
  if (args.toDay && !isIsoDay(args.toDay)) {
    throw new Error("--to-day must be YYYY-MM-DD");
  }
  if (args.fromDay && args.toDay && args.fromDay > args.toDay) {
    throw new Error("--from-day must be <= --to-day");
  }
  if (args.targetsOnly && args.format !== "csv") {
    throw new Error("--targets-only currently supports --format csv only");
  }

  return args;
}

function parsePositiveInt(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(value);
}

function isIsoDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(ms);
}

function normalizePrefix(rawValue, fallbackValue) {
  const prefix = String(rawValue || fallbackValue || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error("Invalid empty prefix");
  }
  return prefix;
}

function findDropboxRoot(cliValue) {
  const candidates = [
    String(cliValue || "").trim(),
    String(process.env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim(),
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

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, json: null, status: "missing_file", bytes: 0 };
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch (_error) {
    return { exists: false, json: null, status: "stat_error", bytes: 0 };
  }
  if (bytes <= 0) {
    return { exists: true, json: null, status: "zero_bytes", bytes };
  }
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return { exists: true, json: null, status: "read_error", bytes };
  }
  try {
    return { exists: true, json: JSON.parse(text), status: "ok", bytes };
  } catch (_error) {
    return { exists: true, json: null, status: "invalid_json", bytes };
  }
}

function normalizeRowCountHint(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return 0;
  }
  const sourceRowCount = Number(manifest.source_row_count);
  if (Number.isFinite(sourceRowCount) && sourceRowCount > 0) {
    return Math.trunc(sourceRowCount);
  }
  const fileRows = Array.isArray(manifest.files)
    ? manifest.files.reduce((sum, entry) => {
      const rowCount = Number(entry?.row_count);
      return Number.isFinite(rowCount) && rowCount > 0 ? sum + Math.trunc(rowCount) : sum;
    }, 0)
    : 0;
  if (fileRows > 0) {
    return fileRows;
  }
  const indexedRows = Number(manifest.indexed_row_count);
  if (Number.isFinite(indexedRows) && indexedRows > 0) {
    return Math.trunc(indexedRows);
  }
  return 0;
}

function summarizeCounts(manifest) {
  const counts = manifest?.timeseries_row_counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return { status: "missing", timeseries_count: 0, total_rows: 0 };
  }
  let timeseriesCount = 0;
  let totalRows = 0;
  for (const [key, value] of Object.entries(counts)) {
    if (!/^\d+$/.test(String(key || ""))) {
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      continue;
    }
    timeseriesCount += 1;
    totalRows += Math.trunc(n);
  }
  if (timeseriesCount <= 0) {
    return { status: "empty_object", timeseries_count: 0, total_rows: 0 };
  }
  return { status: "ok", timeseries_count: timeseriesCount, total_rows: totalRows };
}

function toCsvValue(value) {
  const text = value == null ? "" : String(value);
  if (!/[,"\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => toCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function listObservationConnectorDirs(observationsDomainPath) {
  const out = [];
  if (!fs.existsSync(observationsDomainPath)) {
    return out;
  }
  const dayDirs = fs.readdirSync(observationsDomainPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^day_utc=\d{4}-\d{2}-\d{2}$/.test(entry.name));
  for (const dayDir of dayDirs) {
    const dayUtc = dayDir.name.slice("day_utc=".length);
    const connectorBase = path.join(observationsDomainPath, dayDir.name);
    const connectorDirs = fs.readdirSync(connectorBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^connector_id=\d+$/.test(entry.name));
    for (const connectorDir of connectorDirs) {
      const connectorId = Number(connectorDir.name.slice("connector_id=".length));
      if (!Number.isFinite(connectorId) || connectorId <= 0) {
        continue;
      }
      out.push({
        day_utc: dayUtc,
        connector_id: Math.trunc(connectorId),
        connector_manifest_path: path.join(connectorBase, connectorDir.name, "manifest.json"),
      });
    }
  }
  out.sort((left, right) => {
    if (left.day_utc !== right.day_utc) {
      return left.day_utc.localeCompare(right.day_utc);
    }
    return left.connector_id - right.connector_id;
  });
  return out;
}

function shouldKeepByFilters(row, args) {
  if (args.fromDay && row.day_utc < args.fromDay) return false;
  if (args.toDay && row.day_utc > args.toDay) return false;
  if (args.connectorIds.size > 0 && !args.connectorIds.has(row.connector_id)) return false;
  return true;
}

function buildRows({ observationTargets, observationsTsPrefixPath, args }) {
  const rows = [];
  for (const target of observationTargets) {
    if (!shouldKeepByFilters(target, args)) {
      continue;
    }

    const indexManifestPath = path.join(
      observationsTsPrefixPath,
      `day_utc=${target.day_utc}`,
      `connector_id=${target.connector_id}`,
      "manifest.json",
    );
    const connectorRead = safeReadJson(target.connector_manifest_path);
    const indexRead = safeReadJson(indexManifestPath);
    const connectorCounts = summarizeCounts(connectorRead.json);
    const indexCounts = summarizeCounts(indexRead.json);

    const connectorRowsHint = normalizeRowCountHint(connectorRead.json);
    const indexRowsHint = normalizeRowCountHint(indexRead.json);
    const connectorCountsRequired = connectorRowsHint > 0;
    const indexCountsRequired = indexRowsHint > 0 || connectorRowsHint > 0;

    const connectorIssue = connectorRead.status !== "ok"
      ? connectorRead.status
      : (
        connectorCounts.status === "ok"
          ? ""
          : (connectorCountsRequired ? `timeseries_row_counts_${connectorCounts.status}` : "")
      );
    const indexIssue = indexRead.status !== "ok"
      ? indexRead.status
      : (
        indexCounts.status === "ok"
          ? ""
          : (indexCountsRequired ? `timeseries_row_counts_${indexCounts.status}` : "")
      );

    const hasIssue = Boolean(connectorIssue || indexIssue);
    if (!args.includeOk && !hasIssue) {
      continue;
    }

    rows.push({
      day_utc: target.day_utc,
      connector_id: target.connector_id,
      connector_manifest_issue: connectorIssue || "ok",
      index_manifest_issue: indexIssue || "ok",
      connector_manifest_path: target.connector_manifest_path,
      index_manifest_path: indexManifestPath,
      connector_manifest_bytes: connectorRead.bytes,
      index_manifest_bytes: indexRead.bytes,
      connector_timeseries_count: connectorCounts.timeseries_count,
      index_timeseries_count: indexCounts.timeseries_count,
      connector_rows_hint: connectorRowsHint,
      index_rows_hint: indexRowsHint,
      issue_kind: hasIssue
        ? (
          connectorIssue && indexIssue
            ? "both"
            : (connectorIssue ? "connector_manifest" : "timeseries_index_manifest")
        )
        : "none",
      rebuild_target_csv: `${target.day_utc},${target.connector_id}`,
    });
  }
  return rows;
}

function writeOutput({ args, rows, outputText }) {
  process.stdout.write(outputText);
  if (!args.outPath) {
    return;
  }
  const outDir = path.dirname(args.outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.outPath, outputText, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dropboxRoot = findDropboxRoot(args.root);
  if (!dropboxRoot) {
    throw new Error(
      "No Dropbox R2 history root found. Set --root or UK_AQ_R2_HISTORY_DROPBOX_ROOT.",
    );
  }

  const observationsPrefix = normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX,
    DEFAULT_OBSERVATIONS_PREFIX,
  );
  const observationsTimeseriesPrefix = normalizePrefix(
    process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX,
    DEFAULT_OBSERVATIONS_TS_INDEX_PREFIX,
  );

  const observationsDomainPath = path.join(dropboxRoot, observationsPrefix);
  const observationsTsPrefixPath = path.join(dropboxRoot, observationsTimeseriesPrefix);
  const observationTargets = listObservationConnectorDirs(observationsDomainPath);
  const rows = buildRows({ observationTargets, observationsTsPrefixPath, args });

  if (args.format === "json") {
    const payload = {
      ok: true,
      dropbox_root: dropboxRoot,
      observations_prefix: observationsPrefix,
      observations_timeseries_index_prefix: observationsTimeseriesPrefix,
      row_count: rows.length,
      rows,
    };
    writeOutput({ args, rows, outputText: `${JSON.stringify(payload, null, 2)}\n` });
    return;
  }

  const outputRows = args.targetsOnly
    ? rows.map((row) => ({ day_utc: row.day_utc, connector_id: row.connector_id }))
    : rows;
  const columns = args.targetsOnly
    ? ["day_utc", "connector_id"]
    : [
      "day_utc",
      "connector_id",
      "issue_kind",
      "connector_manifest_issue",
      "index_manifest_issue",
      "connector_rows_hint",
      "index_rows_hint",
      "connector_timeseries_count",
      "index_timeseries_count",
      "connector_manifest_path",
      "index_manifest_path",
    ];
  const csvText = toCsv(outputRows, columns);
  writeOutput({ args, rows, outputText: csvText });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});
