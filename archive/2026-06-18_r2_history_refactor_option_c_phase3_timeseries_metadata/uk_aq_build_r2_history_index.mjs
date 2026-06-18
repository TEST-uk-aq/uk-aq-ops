#!/usr/bin/env node
import fs from "node:fs";
import {
  rebuildR2HistoryIndexes,
  updateR2HistoryIndexesTargeted,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_build_r2_history_index.mjs [options]",
    "",
    "Options:",
    "  --history-version v1|v2              History index layout to build (default: v1)",
    "  --domain observations|aqilevels|both   Domain filter (default: both)",
    "  --kind observations|aqilevels|both     Alias for --domain (used by targeted mode)",
    "  --fetch-concurrency <n>                 Override manifest fetch concurrency",
    "  --max-keys <n>                          Override R2 list page size",
    "  --compute-missing-timeseries-counts     For source manifests lacking",
    "                                          timeseries_row_counts, read each parquet,",
    "                                          compute per-timeseries counts, patch the",
    "                                          source manifest (new manifest_hash), and",
    "                                          build indexes from the patched manifest.",
    "  --targeted                              Run a narrow latest-index update for a known",
    "                                          day range instead of a full history rebuild.",
    "  --from-day YYYY-MM-DD                   Required with --targeted.",
    "  --to-day YYYY-MM-DD                     Required with --targeted.",
    "  --connector-id <n>                      Optional connector filter for --targeted.",
    "  --target <YYYY-MM-DD:connector_id>      Target one observations day+connector pair.",
    "                                          Repeat flag to target multiple pairs.",
    "  --targets-csv <path>                    CSV of targets with day_utc + connector_id",
    "                                          columns (additional columns are ignored).",
    "  -h, --help                              Show this help",
    "",
    "Required env:",
    "  CFLARE_R2_ENDPOINT / R2_ENDPOINT",
    "  CFLARE_R2_REGION / R2_REGION",
    "  CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
    "  CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
    "  R2 bucket via CFLARE_R2_BUCKET / R2_BUCKET",
    "",
    "Optional env:",
    "  UK_AQ_R2_HISTORY_INDEX_VERSION         default: v1",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX   default: history/v1/observations",
    "  UK_AQ_R2_HISTORY_AQILEVELS_PREFIX      default: history/v1/aqilevels/hourly",
    "  UK_AQ_R2_HISTORY_INDEX_PREFIX          default: history/_index",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX",
    "                                         default: history/_index/observations_timeseries",
    "  UK_AQ_R2_HISTORY_AQILEVELS_TIMESERIES_INDEX_PREFIX",
    "                                         default: history/_index/aqilevels_timeseries",
    "  UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX",
    "                                         default: history/v2/observations",
    "  UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX",
    "                                         default: history/v2/aqilevels/hourly/data",
    "  UK_AQ_R2_HISTORY_INDEX_V2_PREFIX       default: history/_index_v2",
    "  UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX",
    "                                         default: history/_index_v2/observations_timeseries",
    "  UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX",
    "                                         default: history/_index_v2/aqilevels_hourly_data_timeseries",
    "  UK_AQ_R2_HISTORY_INDEX_FETCH_CONCURRENCY",
    "  UK_AQ_R2_HISTORY_INDEX_MAX_KEYS",
  ].join("\n"));
}

function parsePositiveInt(raw, flagName) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(value);
}

function parseArgs(argv) {
  const envHistoryVersion = String(process.env.UK_AQ_R2_HISTORY_INDEX_VERSION || "v1")
    .trim()
    .toLowerCase();
  const args = {
    historyVersion: envHistoryVersion || "v1",
    domains: ["observations", "aqilevels"],
    fetchConcurrency: undefined,
    maxKeys: undefined,
    computeMissingTimeseriesCounts: false,
    targeted: false,
    fromDayUtc: undefined,
    toDayUtc: undefined,
    connectorId: undefined,
    observationsTargets: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--history-version") {
      args.historyVersion = parseHistoryVersion(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--history-version=")) {
      args.historyVersion = parseHistoryVersion(arg.slice("--history-version=".length));
      continue;
    }
    if (arg === "--domain") {
      const value = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      applyDomainArg(args, value, "--domain");
      continue;
    }
    if (arg === "--kind") {
      const value = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      applyDomainArg(args, value, "--kind");
      continue;
    }
    if (arg === "--targeted") {
      args.targeted = true;
      continue;
    }
    if (arg === "--from-day") {
      args.fromDayUtc = parseIsoDay(argv[i + 1]);
      if (!args.fromDayUtc) {
        throw new Error("--from-day requires a valid YYYY-MM-DD value");
      }
      i += 1;
      continue;
    }
    if (arg === "--to-day") {
      args.toDayUtc = parseIsoDay(argv[i + 1]);
      if (!args.toDayUtc) {
        throw new Error("--to-day requires a valid YYYY-MM-DD value");
      }
      i += 1;
      continue;
    }
    if (arg === "--connector-id") {
      args.connectorId = parseConnectorId(argv[i + 1], "--connector-id");
      i += 1;
      continue;
    }
    if (arg === "--fetch-concurrency") {
      args.fetchConcurrency = parsePositiveInt(argv[i + 1], "--fetch-concurrency");
      i += 1;
      continue;
    }
    if (arg === "--max-keys") {
      args.maxKeys = parsePositiveInt(argv[i + 1], "--max-keys");
      i += 1;
      continue;
    }
    if (arg === "--compute-missing-timeseries-counts") {
      args.computeMissingTimeseriesCounts = true;
      continue;
    }
    if (arg.startsWith("--kind=")) {
      applyDomainArg(args, String(arg.slice("--kind=".length) || "").trim().toLowerCase(), "--kind");
      continue;
    }
    if (arg.startsWith("--from-day=")) {
      args.fromDayUtc = parseIsoDay(arg.slice("--from-day=".length));
      if (!args.fromDayUtc) {
        throw new Error("--from-day requires a valid YYYY-MM-DD value");
      }
      continue;
    }
    if (arg.startsWith("--to-day=")) {
      args.toDayUtc = parseIsoDay(arg.slice("--to-day=".length));
      if (!args.toDayUtc) {
        throw new Error("--to-day requires a valid YYYY-MM-DD value");
      }
      continue;
    }
    if (arg.startsWith("--connector-id=")) {
      args.connectorId = parseConnectorId(arg.slice("--connector-id=".length), "--connector-id");
      continue;
    }
    if (arg === "--target") {
      const rawValue = String(argv[i + 1] || "").trim();
      if (!rawValue) {
        throw new Error("--target requires YYYY-MM-DD:connector_id");
      }
      args.observationsTargets.push(parseTargetArg(rawValue));
      i += 1;
      continue;
    }
    if (arg === "--targets-csv") {
      const csvPath = String(argv[i + 1] || "").trim();
      if (!csvPath) {
        throw new Error("--targets-csv requires a file path");
      }
      args.observationsTargets.push(...loadTargetsFromCsv(csvPath));
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (args.targeted) {
    if (args.historyVersion !== "v1" && args.historyVersion !== "v2") {
      throw new Error("--targeted is only supported for v1 and v2 indexes");
    }
    if (!args.fromDayUtc || !args.toDayUtc) {
      throw new Error("--targeted requires --from-day and --to-day");
    }
    if (args.toDayUtc < args.fromDayUtc) {
      throw new Error("--to-day must be >= --from-day");
    }
    if (args.observationsTargets.length > 0) {
      throw new Error("--target/--targets-csv may not be used with --targeted");
    }
  } else if (args.fromDayUtc || args.toDayUtc || args.connectorId) {
    throw new Error("--from-day/--to-day/--connector-id require --targeted");
  }

  if (args.observationsTargets.length > 0) {
    if (!args.domains.includes("observations")) {
      throw new Error("--target/--targets-csv may only be used when observations domain is selected");
    }
    const deduped = new Map();
    for (const entry of args.observationsTargets) {
      deduped.set(`${entry.day_utc}|${entry.connector_id}`, entry);
    }
    args.observationsTargets = Array.from(deduped.values()).sort((a, b) => {
      if (a.day_utc !== b.day_utc) {
        return a.day_utc.localeCompare(b.day_utc);
      }
      return a.connector_id - b.connector_id;
    });
  }

  args.historyVersion = parseHistoryVersion(args.historyVersion);

  return args;
}

function parseHistoryVersion(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value !== "v1" && value !== "v2") {
    throw new Error("--history-version must be v1 or v2");
  }
  return value;
}

function applyDomainArg(args, value, flagName) {
  if (value === "both" || !value) {
    args.domains = ["observations", "aqilevels"];
    return;
  }
  if (value !== "observations" && value !== "aqilevels") {
    throw new Error(`${flagName} must be observations, aqilevels, or both`);
  }
  args.domains = [value];
}

function parseIsoDay(value) {
  const day = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return "";
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return "";
  }
  return day;
}

function parseConnectorId(value, flagName = "connector_id") {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Invalid ${flagName}: ${String(value || "")}`);
  }
  return Math.trunc(raw);
}

function parseTargetArg(rawValue) {
  const [dayRaw, connectorRaw] = String(rawValue || "").split(":");
  const dayUtc = parseIsoDay(dayRaw);
  if (!dayUtc) {
    throw new Error(`Invalid --target day_utc: ${String(dayRaw || "")}`);
  }
  const connectorId = parseConnectorId(connectorRaw, "connector_id in --target");
  return { day_utc: dayUtc, connector_id: connectorId };
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function loadTargetsFromCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`--targets-csv file does not exist: ${csvPath}`);
  }
  const csvText = fs.readFileSync(csvPath, "utf8");
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    return [];
  }
  const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const dayIndex = header.indexOf("day_utc");
  const connectorIndex = header.indexOf("connector_id");
  if (dayIndex === -1 || connectorIndex === -1) {
    throw new Error("--targets-csv must include day_utc and connector_id columns");
  }
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]);
    const dayUtc = parseIsoDay(row[dayIndex]);
    if (!dayUtc) {
      continue;
    }
    const connectorId = parseConnectorId(row[connectorIndex], "connector_id in --targets-csv");
    out.push({ day_utc: dayUtc, connector_id: connectorId });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = args.targeted
    ? await updateR2HistoryIndexesTargeted({
        env: process.env,
        historyVersion: args.historyVersion,
        domains: args.domains,
        fromDayUtc: args.fromDayUtc,
        toDayUtc: args.toDayUtc,
        connectorId: args.connectorId,
        fetchConcurrency: args.fetchConcurrency,
        computeMissingTimeseriesCounts: args.computeMissingTimeseriesCounts,
      })
    : await rebuildR2HistoryIndexes({
        env: process.env,
        domains: args.domains,
        historyVersion: args.historyVersion,
        fetchConcurrency: args.fetchConcurrency,
        maxKeys: args.maxKeys,
        computeMissingTimeseriesCounts: args.computeMissingTimeseriesCounts,
        observationsTargets: args.observationsTargets.length ? args.observationsTargets : null,
      });
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});
