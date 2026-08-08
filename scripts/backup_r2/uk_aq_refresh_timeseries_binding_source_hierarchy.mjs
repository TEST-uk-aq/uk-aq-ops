#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasRequiredR2Config,
  normalizePrefix,
  r2GetObject,
  r2HeadObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  refreshTimeseriesBindingSourceHierarchy,
} from "./lib/timeseries_binding_source_hierarchy_v2.mjs";

const DEFAULT_BINDING_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX
  || "history/_index_v2/timeseries_binding",
);
const DEFAULT_BACKUP_INVENTORY_PREFIX = normalizePrefix(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX
  || "history/_index_v2/backup_inventory_v2",
);
const DEFAULT_REPORT_OUT = String(
  process.env.UK_AQ_R2_HISTORY_TIMESERIES_BINDING_SOURCE_HIERARCHY_REPORT_OUT || "",
).trim();
const TRANSIENT_R2_OPERATION_MAX_ATTEMPTS = 3;
const TRANSIENT_R2_OPERATION_RETRY_BASE_MS = 15_000;
const TRANSIENT_R2_STATUS_PATTERN = /\bR2\b.*\bfailed \((408|429|500|502|503|504)\)/i;
const TRANSIENT_R2_ERROR_TOKENS = [
  "connection reset",
  "connection closed",
  "broken pipe",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "ehostunreach",
  "etimedout",
  "timed out",
  "timeout",
  "networkerror",
  "network error",
  "sendrequest",
  "temporarily unavailable",
  "tls",
  "eof",
];

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

function normalizeFingerprint(value, label = "source fingerprint") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string`);
  }
  return normalized;
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/uk_aq_refresh_timeseries_binding_source_hierarchy.mjs [options]",
    "",
    "Options:",
    `  --binding-prefix <p>          Default: ${DEFAULT_BINDING_PREFIX}`,
    `  --backup-inventory-prefix <p> Default: ${DEFAULT_BACKUP_INVENTORY_PREFIX}`,
    "  --source-fingerprint <sha>    Optional authoritative reconciliation fingerprint",
    "  --force-rebuild               Enumerate/rebuild even when refresh state matches",
    "  --dry-run                     Plan only; do not write source hierarchy objects",
    "  --report-out <file>           Write JSON report",
    "  -h, --help",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    binding_prefix: DEFAULT_BINDING_PREFIX,
    backup_inventory_prefix: DEFAULT_BACKUP_INVENTORY_PREFIX,
    source_fingerprint: null,
    force_rebuild: false,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--binding-prefix") {
      args.binding_prefix = normalizePrefix(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--backup-inventory-prefix") {
      args.backup_inventory_prefix = normalizePrefix(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--source-fingerprint") {
      args.source_fingerprint = normalizeFingerprint(
        argv[index + 1],
        "--source-fingerprint",
      );
      index += 1;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--force-rebuild") {
      args.force_rebuild = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.binding_prefix) throw new Error("--binding-prefix must not be empty");
  if (!args.backup_inventory_prefix) {
    throw new Error("--backup-inventory-prefix must not be empty");
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientR2OperationError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  if (TRANSIENT_R2_STATUS_PATTERN.test(message)) return true;
  const normalized = message.toLowerCase();
  return TRANSIENT_R2_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function transientR2OperationRetryDelayMs(attempt) {
  return TRANSIENT_R2_OPERATION_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1));
}

async function refreshHierarchyWithTransientRetry(options) {
  for (let attempt = 1; attempt <= TRANSIENT_R2_OPERATION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await refreshTimeseriesBindingSourceHierarchy(options);
    } catch (error) {
      if (
        !isTransientR2OperationError(error)
        || attempt === TRANSIENT_R2_OPERATION_MAX_ATTEMPTS
      ) {
        throw error;
      }
      const delayMs = transientR2OperationRetryDelayMs(attempt);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Transient R2 error during timeseries binding source hierarchy refresh `
        + `(attempt ${attempt}/${TRANSIENT_R2_OPERATION_MAX_ATTEMPTS}): ${message}`,
      );
      console.warn(`Retrying hierarchy refresh in ${delayMs / 1000}s.`);
      await sleep(delayMs);
    }
  }

  throw new Error("Timeseries binding source hierarchy retry loop exhausted unexpectedly.");
}

async function readJsonMaybe(r2, key) {
  const head = await r2HeadObject({ r2, key });
  if (!head?.exists) return null;
  const object = await r2GetObject({ r2, key });
  try {
    return JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${key}: ${error?.message || error}`);
  }
}

function sourceFingerprintFromState(state, bindingPrefix) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const fingerprint = normalizeFingerprint(state.source_fingerprint);
  if (
    Number(state.schema_version) !== 1
    || state.history_version !== "v2"
    || state.state_kind !== "timeseries_binding_source_state"
    || state.timeseries_binding_index_prefix !== bindingPrefix
    || !fingerprint
  ) return null;
  return fingerprint;
}

function writeReport(filename, payload) {
  if (!filename) return;
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const r2 = r2FromEnv();
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Missing required R2 configuration (CFLARE_R2_* / R2_*)");
  }
  const sourceStateKey = `${args.binding_prefix}/_source_state.json`;
  const sourceState = await readJsonMaybe(r2, sourceStateKey);
  const sourceStateFingerprint = sourceState
    ? sourceFingerprintFromState(sourceState, args.binding_prefix)
    : null;
  if (sourceState && !sourceStateFingerprint && !args.source_fingerprint) {
    throw new Error(`Invalid timeseries binding source state: ${sourceStateKey}`);
  }
  const sourceFingerprint = args.source_fingerprint || sourceStateFingerprint;

  const startedAt = new Date().toISOString();
  const hierarchy = await refreshHierarchyWithTransientRetry({
    r2,
    bindingPrefix: args.binding_prefix,
    backupInventoryRootPrefix: args.backup_inventory_prefix,
    sourceFingerprint,
    forceRebuild: args.force_rebuild,
    writeR2: !args.dry_run,
  });
  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    dry_run: args.dry_run,
    force_rebuild: args.force_rebuild,
    bucket: r2.bucket,
    binding_prefix: args.binding_prefix,
    backup_inventory_prefix: args.backup_inventory_prefix,
    source_state_key: sourceStateKey,
    source_fingerprint: sourceFingerprint,
    source_fingerprint_source: args.source_fingerprint
      ? "argument"
      : sourceStateFingerprint
        ? "source_state"
        : null,
    hierarchy,
  };
  writeReport(args.report_out, report);
  return report;
}

function isMainModule(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  main().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (DEFAULT_REPORT_OUT) writeReport(DEFAULT_REPORT_OUT, payload);
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  });
}
