#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
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
    "  --strict-missing-timeseries-counts      Fail v2 AQI index builds when a non-empty",
    "                                          source pollutant manifest has no usable",
    "                                          timeseries_row_counts.",
    "  --dry-run                               Plan only; no R2 PUTs (default).",
    "  --write-r2                              Execute R2 PUTs after an explicit gate.",
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
    "  UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX",
    "                                         default: history/_index_v2/timeseries",
    "  UK_AQ_R2_HISTORY_INDEX_FETCH_CONCURRENCY",
    "  UK_AQ_R2_HISTORY_INDEX_MAX_KEYS",
    "  UK_AQ_R2_HISTORY_INDEX_STRICT_MISSING_TIMESERIES_COUNTS",
    "                                         default: false",
  ].join("\n"));
}

function parsePositiveInt(raw, flagName) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return Math.trunc(value);
}

function summarizeWriteOutcome(summary) {
  const flags = [];
  if (summary?.latest_index_put_skipped !== undefined) {
    flags.push(summary.latest_index_put_skipped);
  }
  if (summary?.observations_timeseries?.latest_index_put_skipped !== undefined) {
    flags.push(summary.observations_timeseries.latest_index_put_skipped);
  }
  if (summary?.aqilevels_timeseries?.latest_index_put_skipped !== undefined) {
    flags.push(summary.aqilevels_timeseries.latest_index_put_skipped);
  }
  if (summary?.timeseries_metadata?.metadata_put_skipped_count !== undefined) {
    flags.push(summary.timeseries_metadata.metadata_put_skipped_count > 0);
  }
  for (const result of Array.isArray(summary?.results) ? summary.results : []) {
    if (result?.latest_index_put_skipped !== undefined) {
      flags.push(result.latest_index_put_skipped);
    }
    if (result?.put_skipped !== undefined) {
      flags.push(result.put_skipped);
    }
  }
  const sawSkipped = flags.some((value) => value === true);
  const sawWrite = flags.some((value) => value === false);
  return {
    sawSignals: flags.length > 0,
    allSkipped: flags.length > 0 && sawSkipped && !sawWrite,
  };
}

const UNSUCCESSFUL_REPAIR_STATUSES = new Set(["blocked_dependency", "failed"]);

function findUnsuccessfulStatus(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Number(value.blocked_dependency_count || 0) > 0) return "blocked_dependency";
  if (Number(value.failed_count || value.failure_count || 0) > 0) return "failed";
  if (UNSUCCESSFUL_REPAIR_STATUSES.has(value.status)) return value.status;
  if (UNSUCCESSFUL_REPAIR_STATUSES.has(value.verification_status)) return value.verification_status;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const status = findUnsuccessfulStatus(entry, seen);
      if (status) return status;
    }
    return null;
  }
  for (const entry of Object.values(value)) {
    const status = findUnsuccessfulStatus(entry, seen);
    if (status) return status;
  }
  return null;
}

function buildRepairSections(summary, { writeR2, mode }) {
  const blockedDependencyCount = Number(summary?.blocked_dependency_count || 0);
  const outcome = summarizeWriteOutcome(summary);
  const unsuccessfulStatus = findUnsuccessfulStatus(summary);
  const repairStatus = unsuccessfulStatus
    || (blockedDependencyCount > 0 ? "blocked_dependency"
    : (!writeR2 ? "planned" : (outcome.allSkipped ? "skipped_unchanged" : "succeeded")));
  return {
    repair: {
      status: repairStatus,
      planning: {
        status: "planned",
        write_r2: writeR2,
        mode,
        blocked_dependency_count: blockedDependencyCount,
      },
      execution: {
        status: unsuccessfulStatus ? "not_run" : repairStatus,
        write_r2: writeR2,
      },
      verification: {
        status: writeR2 && !unsuccessfulStatus ? repairStatus : "not_run",
        fresh_remote_reads: writeR2 && !unsuccessfulStatus,
      },
    },
  };
}

function parseArgs(argv) {
  const envHistoryVersion = String(process.env.UK_AQ_R2_HISTORY_INDEX_VERSION || "v1")
    .trim()
    .toLowerCase();
  const args = {
    mode: "dry-run",
    historyVersion: envHistoryVersion || "v1",
    domains: ["observations", "aqilevels"],
    fetchConcurrency: undefined,
    maxKeys: undefined,
    computeMissingTimeseriesCounts: false,
    strictMissingTimeseriesCounts: parseBoolEnv(
      process.env.UK_AQ_R2_HISTORY_INDEX_STRICT_MISSING_TIMESERIES_COUNTS,
      false,
    ),
    targeted: false,
    fromDayUtc: undefined,
    toDayUtc: undefined,
    connectorId: undefined,
    observationsTargets: [],
    sawDryRun: false,
    sawWriteR2: false,
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
    if (arg === "--strict-missing-timeseries-counts") {
      args.strictMissingTimeseriesCounts = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
      continue;
    }
    if (arg === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
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

  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
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

function parseBoolEnv(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
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

export function exitCodeForHistoryIndexResult(payload) {
  return payload?.ok === false ? 1 : 0;
}

export async function runHistoryIndexBuild({
  argv = process.argv.slice(2),
  env = process.env,
  rebuildIndexes = rebuildR2HistoryIndexes,
  updateIndexesTargeted = updateR2HistoryIndexesTargeted,
} = {}) {
  const args = parseArgs(argv);
  const writeR2 = args.mode === "write-r2";
  const summary = args.targeted
    ? await updateIndexesTargeted({
        env,
        historyVersion: args.historyVersion,
        domains: args.domains,
        fromDayUtc: args.fromDayUtc,
        toDayUtc: args.toDayUtc,
        connectorId: args.connectorId,
        fetchConcurrency: args.fetchConcurrency,
        computeMissingTimeseriesCounts: args.computeMissingTimeseriesCounts,
        strictMissingTimeseriesCounts: args.strictMissingTimeseriesCounts,
        writeR2,
      })
    : await rebuildIndexes({
        env,
        domains: args.domains,
        historyVersion: args.historyVersion,
        fetchConcurrency: args.fetchConcurrency,
        maxKeys: args.maxKeys,
        computeMissingTimeseriesCounts: args.computeMissingTimeseriesCounts,
        strictMissingTimeseriesCounts: args.strictMissingTimeseriesCounts,
        observationsTargets: args.observationsTargets.length ? args.observationsTargets : null,
        writeR2,
      });
  const repair = buildRepairSections(summary, { writeR2, mode: args.mode });
  const status = repair.repair.status;
  return {
    ...summary,
    ...repair,
    ok: !UNSUCCESSFUL_REPAIR_STATUSES.has(status),
    status,
    mode: args.mode,
    dry_run: !writeR2,
    write_r2: writeR2,
    history_version: args.historyVersion,
    targeted: args.targeted,
  };
}

export async function main({
  run = runHistoryIndexBuild,
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const payload = await run({ argv, env });
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return exitCodeForHistoryIndexResult(payload);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exit(1);
  });
}
