#!/usr/bin/env node
import { rebuildR2HistoryIndexes } from "../../workers/shared/uk_aq_r2_history_index.mjs";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_build_r2_history_index.mjs [options]",
    "",
    "Options:",
    "  --domain observations|aqilevels|both   Domain filter (default: both)",
    "  --fetch-concurrency <n>                 Override manifest fetch concurrency",
    "  --max-keys <n>                          Override R2 list page size",
    "  -h, --help                              Show this help",
    "",
    "Required env:",
    "  CFLARE_R2_ENDPOINT / R2_ENDPOINT",
    "  CFLARE_R2_REGION / R2_REGION",
    "  CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
    "  CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
    "  R2 bucket mapping via CFLARE_R2_BUCKET / R2_BUCKET or R2_BUCKET_DEV/STAGE/PROD",
    "",
    "Optional env:",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX   default: history/v1/observations",
    "  UK_AQ_R2_HISTORY_AQILEVELS_PREFIX      default: history/v1/aqilevels",
    "  UK_AQ_R2_HISTORY_INDEX_PREFIX          default: history/_index",
    "  UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX",
    "                                         default: history/_index/observations_timeseries",
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
  const args = {
    domains: ["observations", "aqilevels"],
    fetchConcurrency: undefined,
    maxKeys: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--domain") {
      const value = String(argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      if (value === "both" || !value) {
        args.domains = ["observations", "aqilevels"];
        continue;
      }
      if (value !== "observations" && value !== "aqilevels") {
        throw new Error("--domain must be observations, aqilevels, or both");
      }
      args.domains = [value];
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
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await rebuildR2HistoryIndexes({
    env: process.env,
    domains: args.domains,
    fetchConcurrency: args.fetchConcurrency,
    maxKeys: args.maxKeys,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
});
