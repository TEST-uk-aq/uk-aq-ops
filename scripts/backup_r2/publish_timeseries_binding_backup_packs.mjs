#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasRequiredR2Config,
  normalizePrefix,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
  publishTimeseriesBindingBackupPacksV1,
} from "./lib/timeseries_binding_backup_pack_v1.mjs";

const DEFAULT_BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const TEST_R2_BUCKET = "uk-aq-history-cic-test";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/publish_timeseries_binding_backup_packs.mjs [options]",
    "",
    "Purpose:",
    "  Build and verify deterministic R2 backup-pack derivatives from the",
    "  authoritative timeseries_binding source hierarchy.",
    "",
    "Default mode:",
    "  Dry-run/read-only. No R2 objects are written.",
    "",
    "Options:",
    `  --binding-prefix <prefix>  Default: ${DEFAULT_BINDING_PREFIX}`,
    `  --pack-prefix <prefix>     Default: ${DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX}`,
    "  --read-concurrency <n>     Concurrent binding reads for rebuilt packs (default: 16)",
    "  --report-out <file>        Write the deterministic JSON report locally",
    "  --dry-run                  Explicit read-only mode (default)",
    "  --write-r2                 Publish changed packs and pack root to TEST R2",
    "  -h, --help",
  ].join("\n"));
}

function normalizePositiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    bindingPrefix: DEFAULT_BINDING_PREFIX,
    packPrefix: DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
    readConcurrency: 16,
    reportOut: "",
    mode: "dry-run",
    sawDryRun: false,
    sawWriteR2: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--binding-prefix") {
      args.bindingPrefix = normalizePrefix(argv[++index]);
    } else if (flag === "--pack-prefix") {
      args.packPrefix = normalizePrefix(argv[++index]);
    } else if (flag === "--read-concurrency") {
      args.readConcurrency = normalizePositiveInteger(argv[++index], flag);
    } else if (flag === "--report-out") {
      args.reportOut = String(argv[++index] || "").trim();
    } else if (flag === "--dry-run") {
      args.mode = "dry-run";
      args.sawDryRun = true;
    } else if (flag === "--write-r2") {
      args.mode = "write-r2";
      args.sawWriteR2 = true;
    } else if (flag === "-h" || flag === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.bindingPrefix) throw new Error("--binding-prefix must not be empty");
  if (!args.packPrefix) throw new Error("--pack-prefix must not be empty");
  if (args.sawDryRun && args.sawWriteR2) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  return args;
}

function r2FromEnv(env = process.env) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
    bucket: String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim(),
    region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(
      env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "",
    ).trim(),
    secret_access_key: String(
      env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "",
    ).trim(),
  };
}

function assertTestWriteTarget(r2) {
  if (String(r2?.bucket || "").trim() !== TEST_R2_BUCKET) {
    throw new Error(
      `Refusing --write-r2 for non-TEST bucket: ${String(r2?.bucket || "").trim() || "(empty)"}`,
    );
  }
}

function writeReport(filename, report) {
  if (!filename) return;
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const r2 = r2FromEnv(env);
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing required R2 configuration (CFLARE_R2_* / R2_*)");
  }
  const writeR2 = args.mode === "write-r2";
  if (writeR2) assertTestWriteTarget(r2);
  const report = await publishTimeseriesBindingBackupPacksV1({
    r2,
    bindingPrefix: args.bindingPrefix,
    packPrefix: args.packPrefix,
    writeR2,
    readConcurrency: args.readConcurrency,
  });
  writeReport(args.reportOut, report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
