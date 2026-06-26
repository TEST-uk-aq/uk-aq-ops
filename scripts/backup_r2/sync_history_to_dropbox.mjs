#!/usr/bin/env node
// Sync R2 history folders to Dropbox using the R2-side backup inventory.
//
// The inventory at <source-root>/<inventory-rel-path> is the single source of
// truth for what exists in R2. This script reads it once, compares each entry
// hash against the Dropbox checkpoint hash, and copies only changed/missing
// units. It never scans R2 manifests directly — that is the inventory
// builder's job (scripts/backup_r2/build_backup_inventory.mjs).
//
// If the inventory is missing/invalid/wrong-schema, this script exits non-zero
// with an actionable message. There is no fallback to direct manifest
// scanning; recovery is to re-run the builder.
//
// Checkpoint state (in Dropbox) is extended additively:
//   {
//     version, created_at, updated_at,
//     domains: { observations: {days: {...}, ...}, aqilevels: {...}, core: {...} },
//     index_files: { observations_latest: {relative_path, copied_at, hash, size}, ... },
//     index_tree_units: { observations_timeseries: { units: { "day_utc=.../connector_id=.../manifest.json": {...} } }, ... },
//     committed_connector_units: { observations: { units: { "day_utc=.../connector_id=.../manifest.json": {...} } } }
//   }
// Old checkpoint files lacking the new sections are accepted; the new sections
// are populated on first inventory-driven run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinTargetPath,
  rcloneCat,
  rcloneCatMaybe,
  rcloneDeleteFile,
  rcloneLsjsonRecursive,
  runRclone,
  runRcloneWithRetry,
  sha256Hex,
  uploadFromTempFile,
} from "./lib/rclone.mjs";
import {
  COMMITTED_CONNECTOR_UNIT_KEYS,
  RUN_MANIFEST_UNIT_KEYS,
  defaultInventoryRelPathForBackupVersion,
  defaultStateRelPathForBackupVersion,
  DOMAIN_NAMES,
  domainNamesForBackupVersion,
  indexFileKeysForBackupVersion,
  indexTreeKeysForBackupVersion,
  loadInventory,
  parseBackupVersion,
  resolveBackupVersion,
} from "./lib/inventory.mjs";

function parseNonNegativeInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (intValue < 0) return fallback;
  return intValue;
}

const ENV_STATE_REL_PATH =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH || "").trim();
const DEFAULT_MAX_DAYS_PER_RUN = parseNonNegativeInt(
  process.env.UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN,
  0,
);
const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim() || "rclone";
const DEFAULT_REPORT_OUT = String(process.env.UK_AQ_R2_HISTORY_BACKUP_REPORT_OUT || "").trim();
const ENV_INVENTORY_REL_PATH =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH || "").trim();
const DROPBOX_WRITE_RETRY_MAX_ATTEMPTS = 7;
const DROPBOX_WRITE_RETRY_INITIAL_DELAY_MS = 5_000;
const DROPBOX_WRITE_RETRY_MAX_DELAY_MS = 60_000;
const DROPBOX_WRITE_RETRY_BACKOFF_MULTIPLIER = 2;
const DROPBOX_READ_LIST_RETRY_MAX_ATTEMPTS = 5;
const DROPBOX_READ_LIST_RETRY_INITIAL_DELAY_MS = 10_000;
const DROPBOX_READ_LIST_RETRY_MAX_DELAY_MS = 60_000;
const DROPBOX_READ_LIST_RETRY_BACKOFF_MULTIPLIER = 2;
const PRUNED_RELATIVE_PATH_REPORT_LIMIT = 200;
const PRUNE_STATE_KIND = "uk_aq_r2_history_backup_prune_state";
const PRUNE_STATE_VERSION = 1;
const V2_PRUNE_STATE_REL_PATH = "_ops/checkpoints/r2_history_backup_prune_state_v2.json";

function isDropboxTooManyWriteOperationsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /too_many_write_operations/i.test(message);
}

function onDropboxWriteRetry(event) {
  const errMessage = event.error instanceof Error ? event.error.message : String(event.error);
  const compactMessage = errMessage.split("\n")[0] || "unknown error";
  const retryAfterSec = Math.ceil(Number(event.delay_ms || 0) / 1000);
  console.warn(
    `[uk_aq_r2_history_dropbox_backup] Dropbox write throttled `
    + `(attempt ${event.attempt}/${event.max_attempts}); `
    + `retrying in ${retryAfterSec}s. ${compactMessage}`,
  );
}

function dropboxWriteRetryOptions() {
  return {
    max_attempts: DROPBOX_WRITE_RETRY_MAX_ATTEMPTS,
    initial_delay_ms: DROPBOX_WRITE_RETRY_INITIAL_DELAY_MS,
    max_delay_ms: DROPBOX_WRITE_RETRY_MAX_DELAY_MS,
    backoff_multiplier: DROPBOX_WRITE_RETRY_BACKOFF_MULTIPLIER,
    should_retry: isDropboxTooManyWriteOperationsError,
    on_retry: onDropboxWriteRetry,
  };
}

function runDropboxWriteAwareRclone(rcloneBin, rcloneArgs) {
  runRcloneWithRetry(rcloneBin, rcloneArgs, dropboxWriteRetryOptions());
}

export function isDropboxTransientReadListError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:path\/not_folder|too_many_requests|rate(?:[ _-]?limit|_limited)|too many requests|timeout|timed out|connection reset|connection refused|temporary failure|temporarily unavailable|server error|internal_error|\b5\d\d\b|\b429\b)/i.test(
    message,
  );
}

export function dropboxReadListRetryOptions({
  retryStats = null,
  initialDelayMs = DROPBOX_READ_LIST_RETRY_INITIAL_DELAY_MS,
  maxDelayMs = DROPBOX_READ_LIST_RETRY_MAX_DELAY_MS,
} = {}) {
  return {
    max_attempts: DROPBOX_READ_LIST_RETRY_MAX_ATTEMPTS,
    initial_delay_ms: initialDelayMs,
    max_delay_ms: maxDelayMs,
    backoff_multiplier: DROPBOX_READ_LIST_RETRY_BACKOFF_MULTIPLIER,
    should_retry: isDropboxTransientReadListError,
    on_retry: (event) => {
      if (retryStats) {
        retryStats.retry_count += 1;
        retryStats.max_attempts_used = Math.max(
          retryStats.max_attempts_used,
          Number(event.attempt || 0) + 1,
        );
      }
      console.warn(
        `[backup-r2] retrying Dropbox read/list after transient rclone error `
        + `attempt=${event.attempt} max_attempts=${event.max_attempts} `
        + `delay_ms=${event.delay_ms} args=${event.args.join(" ")}`,
      );
    },
    on_retry_exhausted: (event) => {
      if (retryStats) {
        retryStats.exhausted_count += 1;
        retryStats.max_attempts_used = Math.max(
          retryStats.max_attempts_used,
          Number(event.attempt || 0),
        );
      }
    },
  };
}

function emptyReadListRetryStats() {
  return {
    retry_count: 0,
    exhausted_count: 0,
    max_attempts_used: 1,
  };
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/sync_history_to_dropbox.mjs \\",
      "    --source-root <rclone-source-root> \\",
      "    --dest-root <rclone-destination-root> [options]",
      "",
      "Required:",
      "  --source-root   Example: uk_aq_r2:uk-aq-history-cic-test",
      "  --dest-root     Example: uk_aq_dropbox:/CIC-Test/R2_history_backup",
      "",
      "Optional:",
      "  --backup-version <v>         v1 | v2. Default: UK_AQ_R2_HISTORY_VERSION",
      "  --inventory-rel-path <p>     Default: selected-version inventory path",
      "  --state-rel-path <path>      Default: selected-version checkpoint path",
      "  --domain <name>              observations | aqilevels | aqilevels_debug | core (repeatable)",
      "  --max-days-per-run <N>       Safety throttle on day copies; 0 = unlimited",
      "  --prune-scope <scope>        all | changed. Default: all",
      "  --force-prune-recheck        Ignore v2 prune checkpoint skip entries",
      "  --no-prune-stale-parquet     Disable manifest-guided stale Parquet pruning",
      `  --rclone-bin <name>          Default: ${DEFAULT_RCLONE_BIN}`,
      "  --report-out <file>          Write JSON report to file",
      "  --dry-run                    Plan only; no copies, no checkpoint writes",
      "  --show-version               Print resolved backup config and exit",
      "  -h, --help",
      "",
      "Requires a valid inventory at <source-root>/<inventory-rel-path>. Run",
      "scripts/backup_r2/build_backup_inventory.mjs first.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    backup_version: "",
    source_root: "",
    dest_root: "",
    inventory_rel_path: ENV_INVENTORY_REL_PATH,
    state_rel_path: ENV_STATE_REL_PATH,
    domains: [],
    max_days_per_run: DEFAULT_MAX_DAYS_PER_RUN,
    prune_scope: "all",
    force_prune_recheck: false,
    prune_stale_parquet: true,
    rclone_bin: DEFAULT_RCLONE_BIN,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
    show_version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backup-version") {
      args.backup_version = parseBackupVersion(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--source-root") {
      args.source_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dest-root") {
      args.dest_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--inventory-rel-path") {
      args.inventory_rel_path =
        String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--state-rel-path") {
      args.state_rel_path = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--domain") {
      const domain = String(argv[i + 1] || "").trim();
      if (!DOMAIN_NAMES.includes(domain)) {
        throw new Error(`Invalid --domain value: ${domain}`);
      }
      args.domains.push(domain);
      i += 1;
      continue;
    }
    if (arg === "--max-days-per-run") {
      const raw = String(argv[i + 1] || "").trim();
      const parsed = parseNonNegativeInt(raw, Number.NaN);
      if (!Number.isFinite(parsed)) {
        throw new Error("--max-days-per-run must be a non-negative integer");
      }
      args.max_days_per_run = parsed;
      i += 1;
      continue;
    }
    if (arg === "--prune-scope") {
      const scope = String(argv[i + 1] || "").trim();
      if (!["changed", "all"].includes(scope)) {
        throw new Error("--prune-scope must be changed or all");
      }
      args.prune_scope = scope;
      i += 1;
      continue;
    }
    if (arg === "--no-prune-stale-parquet") {
      args.prune_stale_parquet = false;
      continue;
    }
    if (arg === "--force-prune-recheck") {
      args.force_prune_recheck = true;
      continue;
    }
    if (arg === "--rclone-bin") {
      args.rclone_bin = String(argv[i + 1] || "").trim() || DEFAULT_RCLONE_BIN;
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
    if (arg === "--show-version") {
      args.show_version = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.backup_version) {
    args.backup_version = resolveBackupVersion(process.env);
  }

  if (!args.inventory_rel_path) {
    args.inventory_rel_path = defaultInventoryRelPathForBackupVersion(args.backup_version);
  }
  if (!args.state_rel_path) {
    args.state_rel_path = defaultStateRelPathForBackupVersion(args.backup_version);
  }

  if (args.show_version) {
    return args;
  }

  if (!args.source_root) throw new Error("--source-root is required");
  if (!args.dest_root) throw new Error("--dest-root is required");
  if (!args.inventory_rel_path) throw new Error("--inventory-rel-path cannot be empty");
  if (!args.state_rel_path) throw new Error("--state-rel-path cannot be empty");

  if (args.domains.length === 0) {
    args.domains = domainNamesForBackupVersion(args.backup_version);
  } else {
    args.domains = Array.from(new Set(args.domains));
  }

  return args;
}

// ---- Checkpoint state ----

function emptyDomainState() {
  return {
    days: {},
    last_successful_day_utc: null,
    last_successful_copy_at: null,
  };
}

function emptyIndexTreeUnitsState(indexTreeKeys = []) {
  const out = {};
  for (const treeKey of indexTreeKeys) {
    out[treeKey] = { units: {} };
  }
  return out;
}

function emptyCommittedConnectorUnitsState() {
  const out = {};
  for (const key of COMMITTED_CONNECTOR_UNIT_KEYS) {
    out[key] = { units: {} };
  }
  return out;
}

function emptyRunManifestUnitsState() {
  const out = {};
  for (const key of RUN_MANIFEST_UNIT_KEYS) {
    out[key] = { units: {} };
  }
  return out;
}

function emptyCheckpointState(nowIso, {
  backupVersion = "v1",
  domainNames = domainNamesForBackupVersion(backupVersion),
  indexTreeKeys = indexTreeKeysForBackupVersion(backupVersion),
} = {}) {
  const domains = {};
  for (const domain of domainNames) {
    domains[domain] = emptyDomainState();
  }
  return {
    version: 1,
    backup_version: backupVersion,
    created_at: nowIso,
    updated_at: nowIso,
    domains,
    index_files: {},
    index_tree_units: emptyIndexTreeUnitsState(indexTreeKeys),
    committed_connector_units: emptyCommittedConnectorUnitsState(),
    run_manifest_units: emptyRunManifestUnitsState(),
  };
}

export function sanitizeCheckpointState(rawState, {
  backupVersion = "v1",
  domainNames = domainNamesForBackupVersion(backupVersion),
  indexFileKeys = indexFileKeysForBackupVersion(backupVersion),
  indexTreeKeys = indexTreeKeysForBackupVersion(backupVersion),
} = {}) {
  const nowIso = new Date().toISOString();
  const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
    ? rawState
    : {};

  const domains = {};
  for (const domain of domainNames) {
    const rawDomain = state.domains && typeof state.domains === "object"
      ? state.domains[domain]
      : null;
    const dayMap = rawDomain && typeof rawDomain === "object" && rawDomain.days && typeof rawDomain.days === "object"
      ? rawDomain.days
      : {};

    const cleanedDayMap = {};
    for (const [dayUtc, entry] of Object.entries(dayMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      cleanedDayMap[dayUtc] = {
        manifest_key: String(entry.manifest_key || "").trim(),
        copied_at: String(entry.copied_at || "").trim(),
        manifest_hash: String(entry.manifest_hash || "").trim(),
      };
    }

    domains[domain] = {
      days: cleanedDayMap,
      last_successful_day_utc: rawDomain && typeof rawDomain.last_successful_day_utc === "string"
        ? rawDomain.last_successful_day_utc
        : null,
      last_successful_copy_at: rawDomain && typeof rawDomain.last_successful_copy_at === "string"
        ? rawDomain.last_successful_copy_at
        : null,
    };
  }

  // Index files (new section). Old checkpoints lack this; default to empty.
  const indexFiles = {};
  const rawIndexFiles = state.index_files && typeof state.index_files === "object" && !Array.isArray(state.index_files)
    ? state.index_files
    : {};
  for (const indexKey of indexFileKeys) {
    const entry = rawIndexFiles[indexKey];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      indexFiles[indexKey] = {
        relative_path: String(entry.relative_path || "").trim(),
        copied_at: String(entry.copied_at || "").trim(),
        hash: String(entry.hash || "").trim(),
        size: Number.isFinite(Number(entry.size)) ? Math.trunc(Number(entry.size)) : null,
      };
    }
  }

  // Index tree units (new section). Old checkpoints lack this.
  const indexTreeUnits = emptyIndexTreeUnitsState(indexTreeKeys);
  const rawTreeUnits = state.index_tree_units && typeof state.index_tree_units === "object" && !Array.isArray(state.index_tree_units)
    ? state.index_tree_units
    : {};
  for (const treeKey of indexTreeKeys) {
    const rawTree = rawTreeUnits[treeKey];
    const rawUnits = rawTree && typeof rawTree === "object" && rawTree.units && typeof rawTree.units === "object"
      ? rawTree.units
      : {};
    const cleanedUnits = {};
    for (const [unitKey, entry] of Object.entries(rawUnits)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      cleanedUnits[String(unitKey)] = {
        relative_path: String(entry.relative_path || "").trim(),
        copied_at: String(entry.copied_at || "").trim(),
        hash: String(entry.hash || "").trim(),
        size: Number.isFinite(Number(entry.size)) ? Math.trunc(Number(entry.size)) : null,
      };
    }
    indexTreeUnits[treeKey] = { units: cleanedUnits };
  }

  function cleanFileUnitMap(rawUnits) {
    const cleanedUnits = {};
    for (const [unitKey, entry] of Object.entries(rawUnits || {})) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      cleanedUnits[String(unitKey)] = {
        relative_path: String(entry.relative_path || "").trim(),
        copied_at: String(entry.copied_at || "").trim(),
        hash: String(entry.hash || "").trim(),
        size: Number.isFinite(Number(entry.size)) ? Math.trunc(Number(entry.size)) : null,
      };
    }
    return cleanedUnits;
  }

  // Committed connector-manifest units (new section). Old checkpoints lack this.
  const committedConnectorUnits = emptyCommittedConnectorUnitsState();
  const rawCommittedUnits = state.committed_connector_units
    && typeof state.committed_connector_units === "object"
    && !Array.isArray(state.committed_connector_units)
    ? state.committed_connector_units
    : {};
  for (const domainKey of COMMITTED_CONNECTOR_UNIT_KEYS) {
    const rawDomain = rawCommittedUnits[domainKey];
    const rawUnits = rawDomain && typeof rawDomain === "object" && rawDomain.units && typeof rawDomain.units === "object"
      ? rawDomain.units
      : {};
    committedConnectorUnits[domainKey] = { units: cleanFileUnitMap(rawUnits) };
  }

  const runManifestUnits = emptyRunManifestUnitsState();
  const rawRunManifestUnits = state.run_manifest_units
    && typeof state.run_manifest_units === "object"
    && !Array.isArray(state.run_manifest_units)
    ? state.run_manifest_units
    : {};
  for (const domainKey of RUN_MANIFEST_UNIT_KEYS) {
    const rawDomain = rawRunManifestUnits[domainKey];
    const rawUnits = rawDomain && typeof rawDomain === "object" && rawDomain.units && typeof rawDomain.units === "object"
      ? rawDomain.units
      : {};
    runManifestUnits[domainKey] = { units: cleanFileUnitMap(rawUnits) };
  }

  return {
    version: Number.isFinite(Number(state.version)) ? Number(state.version) : 1,
    backup_version: typeof state.backup_version === "string" && state.backup_version
      ? state.backup_version
      : backupVersion,
    created_at: typeof state.created_at === "string" && state.created_at ? state.created_at : nowIso,
    updated_at: typeof state.updated_at === "string" && state.updated_at ? state.updated_at : nowIso,
    domains,
    index_files: indexFiles,
    index_tree_units: indexTreeUnits,
    committed_connector_units: committedConnectorUnits,
    run_manifest_units: runManifestUnits,
  };
}

function loadCheckpointState(rcloneBin, checkpointPath, options = {}) {
  const nowIso = new Date().toISOString();
  const result = rcloneCatMaybe(rcloneBin, checkpointPath, options.retryOptions);
  if (!result.found) {
    return { state: emptyCheckpointState(nowIso, options), existed: false };
  }
  try {
    return {
      state: sanitizeCheckpointState(JSON.parse(result.text), options),
      existed: true,
    };
  } catch {
    throw new Error(`Checkpoint state is not valid JSON: ${checkpointPath}`);
  }
}

function writeCheckpointState(rcloneBin, checkpointPath, state) {
  uploadFromTempFile(
    rcloneBin,
    checkpointPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "uk_aq_r2_history_backup_state_",
    dropboxWriteRetryOptions(),
  );
}

function emptyPruneCheckpointState(nowIso) {
  return {
    version: PRUNE_STATE_VERSION,
    kind: PRUNE_STATE_KIND,
    backup_version: "v2",
    created_at: nowIso,
    updated_at: nowIso,
    units: {},
  };
}

function sanitizePruneCheckpointState(rawState, nowIso) {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    throw new Error("root is not a JSON object");
  }
  if (rawState.kind !== PRUNE_STATE_KIND) {
    throw new Error(`unexpected kind=${JSON.stringify(rawState.kind)}`);
  }
  if (rawState.version !== PRUNE_STATE_VERSION) {
    throw new Error(`unexpected version=${JSON.stringify(rawState.version)}`);
  }
  if (rawState.backup_version !== "v2") {
    throw new Error(`unexpected backup_version=${JSON.stringify(rawState.backup_version)}`);
  }

  const units = {};
  const rawUnits = rawState.units && typeof rawState.units === "object" && !Array.isArray(rawState.units)
    ? rawState.units
    : {};
  for (const [rawUnitPath, rawEntry] of Object.entries(rawUnits)) {
    const unitPath = normalizePosixRelativePath(rawUnitPath);
    if (!unitPath || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const manifestHash = String(rawEntry.manifest_hash || "").trim();
    const status = String(rawEntry.status || "").trim();
    if (!manifestHash || status !== "ok") {
      continue;
    }
    units[unitPath] = {
      manifest_hash: manifestHash,
      status: "ok",
      pruned_at: String(rawEntry.pruned_at || "").trim(),
      manifest_count: Number.isFinite(Number(rawEntry.manifest_count)) ? Math.trunc(Number(rawEntry.manifest_count)) : 0,
      manifest_referenced_parquet_count: Number.isFinite(Number(rawEntry.manifest_referenced_parquet_count))
        ? Math.trunc(Number(rawEntry.manifest_referenced_parquet_count))
        : 0,
      actual_destination_parquet_count: Number.isFinite(Number(rawEntry.actual_destination_parquet_count))
        ? Math.trunc(Number(rawEntry.actual_destination_parquet_count))
        : 0,
      stale_deleted_count: Number.isFinite(Number(rawEntry.stale_deleted_count))
        ? Math.trunc(Number(rawEntry.stale_deleted_count))
        : 0,
    };
  }

  return {
    version: PRUNE_STATE_VERSION,
    kind: PRUNE_STATE_KIND,
    backup_version: "v2",
    created_at: typeof rawState.created_at === "string" && rawState.created_at ? rawState.created_at : nowIso,
    updated_at: typeof rawState.updated_at === "string" && rawState.updated_at ? rawState.updated_at : nowIso,
    units,
  };
}

function loadPruneCheckpointState(rcloneBin, checkpointPath, retryOptions = null) {
  const nowIso = new Date().toISOString();
  const empty = emptyPruneCheckpointState(nowIso);
  const result = rcloneCatMaybe(rcloneBin, checkpointPath, retryOptions);
  if (!result.found) {
    return {
      state: empty,
      existed: false,
      loaded: false,
      used_for_skip: true,
      warnings: [],
    };
  }
  try {
    return {
      state: sanitizePruneCheckpointState(JSON.parse(result.text), nowIso),
      existed: true,
      loaded: true,
      used_for_skip: true,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: empty,
      existed: true,
      loaded: false,
      used_for_skip: false,
      warnings: [`Ignoring invalid v2 prune checkpoint at ${checkpointPath}: ${message}`],
    };
  }
}

function writePruneCheckpointState(rcloneBin, checkpointPath, state) {
  uploadFromTempFile(
    rcloneBin,
    checkpointPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "uk_aq_r2_history_backup_prune_state_",
    dropboxWriteRetryOptions(),
  );
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) return;
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ---- Checkpoint marking ----

function markDayCopied(state, domain, dayUtc, details) {
  const domainState = state.domains[domain] || emptyDomainState();
  domainState.days[dayUtc] = {
    manifest_key: details.manifest_key,
    copied_at: details.copied_at,
    manifest_hash: details.manifest_hash,
  };
  domainState.last_successful_day_utc = dayUtc;
  domainState.last_successful_copy_at = details.copied_at;
  state.domains[domain] = domainState;
  state.updated_at = details.copied_at;
}

function markIndexFileCopied(state, indexKey, details) {
  state.index_files[indexKey] = {
    relative_path: details.relative_path,
    copied_at: details.copied_at,
    hash: details.hash,
    size: details.size,
  };
  state.updated_at = details.copied_at;
}

function markIndexTreeUnitCopied(state, treeKey, unitKey, details) {
  if (!state.index_tree_units[treeKey] || typeof state.index_tree_units[treeKey] !== "object") {
    state.index_tree_units[treeKey] = { units: {} };
  }
  state.index_tree_units[treeKey].units[unitKey] = {
    relative_path: details.relative_path,
    copied_at: details.copied_at,
    hash: details.hash,
    size: details.size,
  };
  state.updated_at = details.copied_at;
}

function markRunManifestUnitCopied(state, domainKey, unitKey, details) {
  if (!state.run_manifest_units[domainKey]
      || typeof state.run_manifest_units[domainKey] !== "object") {
    state.run_manifest_units[domainKey] = { units: {} };
  }
  state.run_manifest_units[domainKey].units[unitKey] = {
    relative_path: details.relative_path,
    copied_at: details.copied_at,
    hash: details.hash,
    size: details.size,
  };
  state.updated_at = details.copied_at;
}

function markCommittedConnectorUnitCopied(state, domainKey, unitKey, details) {
  if (!state.committed_connector_units[domainKey]
      || typeof state.committed_connector_units[domainKey] !== "object") {
    state.committed_connector_units[domainKey] = { units: {} };
  }
  state.committed_connector_units[domainKey].units[unitKey] = {
    relative_path: details.relative_path,
    copied_at: details.copied_at,
    hash: details.hash,
    size: details.size,
  };
  state.updated_at = details.copied_at;
}

// ---- Copy primitives ----

function copyDayFolder(rcloneBin, sourceDayPath, destDayPath, dryRun) {
  const args = [
    "copy",
    sourceDayPath,
    destDayPath,
    "--check-first",
    "--transfers", "8",
    "--checkers", "16",
    "--fast-list",
  ];
  if (dryRun) args.push("--dry-run");
  if (dryRun) {
    runRclone(rcloneBin, args);
    return;
  }
  runDropboxWriteAwareRclone(rcloneBin, args);
}

function copyFilePath(rcloneBin, sourcePath, destPath, dryRun) {
  const args = ["copyto", sourcePath, destPath, "--check-first"];
  if (dryRun) args.push("--dry-run");
  if (dryRun) {
    runRclone(rcloneBin, args);
    return;
  }
  runDropboxWriteAwareRclone(rcloneBin, args);
}

// ---- Manifest-guided stale Parquet pruning ----

function normalizePosixRelativePath(rawPath) {
  const cleaned = String(rawPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return "";
  const normalized = path.posix.normalize(cleaned);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return "";
  }
  return normalized;
}

function pathFromLsjsonEntry(entry) {
  return normalizePosixRelativePath(entry?.Path || entry?.Name || "");
}

function toUnitRelativeManifestPath(rawPath, unitRelativePath, manifestRelativePath) {
  const raw = normalizePosixRelativePath(rawPath);
  if (!raw || !raw.endsWith(".parquet")) return null;

  const unit = normalizePosixRelativePath(unitRelativePath);
  if (!unit) {
    throw new Error(`Invalid prune unit path: ${unitRelativePath}`);
  }

  let relPath = "";
  if (raw === unit || raw.startsWith(`${unit}/`)) {
    relPath = raw.slice(unit.length).replace(/^\/+/, "");
  } else if (raw.startsWith("history/")) {
    throw new Error(
      `Manifest parquet path is outside prune unit: unit=${unit} path=${raw}`,
    );
  } else if (raw.includes("/")) {
    relPath = raw;
  } else {
    const manifestRel = normalizePosixRelativePath(manifestRelativePath);
    const manifestDir = manifestRel && manifestRel.includes("/")
      ? path.posix.dirname(manifestRel)
      : "";
    relPath = manifestDir ? path.posix.join(manifestDir, raw) : raw;
  }

  const normalizedRel = normalizePosixRelativePath(relPath);
  if (!normalizedRel || normalizedRel.startsWith("history/") || !normalizedRel.endsWith(".parquet")) {
    throw new Error(
      `Manifest parquet path cannot be normalized safely: unit=${unit} path=${raw}`,
    );
  }
  return normalizedRel;
}

function addManifestParquetReference(expectedPaths, rawPath, context) {
  const relPath = toUnitRelativeManifestPath(
    rawPath,
    context.unit_relative_path,
    context.manifest_relative_path,
  );
  if (relPath) expectedPaths.add(relPath);
}

export function buildStaleParquetPrunePlan({
  unit_relative_path,
  manifest_entries,
  actual_file_entries,
} = {}) {
  const unitRelativePath = normalizePosixRelativePath(unit_relative_path);
  if (!unitRelativePath) {
    throw new Error(`Invalid prune unit path: ${unit_relative_path}`);
  }
  const manifests = Array.isArray(manifest_entries) ? manifest_entries : [];
  if (manifests.length === 0) {
    throw new Error(`No manifest.json files found for prune unit: ${unitRelativePath}`);
  }

  const expectedPaths = new Set();
  for (const entry of manifests) {
    const manifestRelativePath = normalizePosixRelativePath(entry?.relative_path || "");
    if (!manifestRelativePath || !manifestRelativePath.endsWith("manifest.json")) {
      throw new Error(`Invalid manifest path for prune unit ${unitRelativePath}: ${entry?.relative_path || ""}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(String(entry?.text || ""));
    } catch (error) {
      throw new Error(
        `Failed to parse manifest for prune unit ${unitRelativePath} at ${manifestRelativePath}: ${error?.message || error}`,
      );
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`Manifest root is not a JSON object for prune unit ${unitRelativePath} at ${manifestRelativePath}`);
    }

    const context = {
      unit_relative_path: unitRelativePath,
      manifest_relative_path: manifestRelativePath,
    };
    if (Array.isArray(manifest.parquet_object_keys)) {
      for (const rawPath of manifest.parquet_object_keys) {
        addManifestParquetReference(expectedPaths, rawPath, context);
      }
    }
    if (Array.isArray(manifest.files)) {
      for (const fileEntry of manifest.files) {
        addManifestParquetReference(
          expectedPaths,
          fileEntry?.key || fileEntry?.relative_path || fileEntry?.path || fileEntry?.name,
          context,
        );
      }
    }
  }

  const actualPaths = new Set();
  for (const entry of Array.isArray(actual_file_entries) ? actual_file_entries : []) {
    const relPath = pathFromLsjsonEntry(entry);
    if (relPath && relPath.endsWith(".parquet")) {
      actualPaths.add(relPath);
    }
  }

  if (expectedPaths.size === 0 && actualPaths.size > 0) {
    throw new Error(
      `No manifest-referenced Parquet paths found for prune unit ${unitRelativePath}; refusing to delete destination files`,
    );
  }

  const stalePaths = Array.from(actualPaths)
    .filter((relPath) => !expectedPaths.has(relPath))
    .sort();

  return {
    unit_relative_path: unitRelativePath,
    manifest_count: manifests.length,
    manifest_referenced_parquet_count: expectedPaths.size,
    actual_destination_parquet_count: actualPaths.size,
    stale_relative_paths: stalePaths,
  };
}

function loadManifestEntriesForPrune(rcloneBin, manifestRootPath, retryOptions = null) {
  const entries = rcloneLsjsonRecursive(rcloneBin, manifestRootPath, {
    hash: false,
    retryOptions,
  });
  return entries
    .map((entry) => pathFromLsjsonEntry(entry))
    .filter((relPath) => relPath.endsWith("manifest.json"))
    .sort()
    .map((relativePath) => ({
      relative_path: relativePath,
      text: rcloneCat(
        rcloneBin,
        joinTargetPath(manifestRootPath, relativePath),
        retryOptions,
      ),
    }));
}

function loadActualParquetEntriesForPrune(rcloneBin, destUnitPath, retryOptions = null) {
  return rcloneLsjsonRecursive(rcloneBin, destUnitPath, {
    hash: false,
    retryOptions,
  })
    .map((entry) => ({ ...entry, Path: pathFromLsjsonEntry(entry) }))
    .filter((entry) => entry.Path.endsWith(".parquet"));
}

export function pruneStaleParquetForUnit({
  rcloneBin,
  manifestRootPath,
  destUnitPath,
  unitRelativePath,
  dryRun = false,
  readListRetryOptions = null,
  manifestReadListRetryOptions = readListRetryOptions,
  destinationReadListRetryOptions = readListRetryOptions,
} = {}) {
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: unitRelativePath,
    manifest_entries: loadManifestEntriesForPrune(
      rcloneBin,
      manifestRootPath,
      manifestReadListRetryOptions,
    ),
    actual_file_entries: loadActualParquetEntriesForPrune(
      rcloneBin,
      destUnitPath,
      destinationReadListRetryOptions,
    ),
  });

  const deletedPaths = [];
  const dryRunPaths = [];
  for (const relPath of plan.stale_relative_paths) {
    if (dryRun) {
      dryRunPaths.push(relPath);
      continue;
    }
    rcloneDeleteFile(
      rcloneBin,
      joinTargetPath(destUnitPath, relPath),
      dropboxWriteRetryOptions(),
    );
    deletedPaths.push(relPath);
  }

  return {
    prune_attempted: true,
    prune_skipped: false,
    unit_relative_path: plan.unit_relative_path,
    manifest_count: plan.manifest_count,
    manifest_referenced_parquet_count: plan.manifest_referenced_parquet_count,
    actual_destination_parquet_count: plan.actual_destination_parquet_count,
    prune_deleted_count: deletedPaths.length,
    prune_dry_run_delete_count: dryRunPaths.length,
    prune_error_count: 0,
    pruned_relative_paths: dryRun ? dryRunPaths : deletedPaths,
    pruned_relative_paths_truncated: false,
  };
}

function emptyPruneReport(args) {
  return {
    enabled: Boolean(args.prune_stale_parquet),
    scope: args.prune_scope,
    force_recheck: Boolean(args.force_prune_recheck),
    prune_attempted: false,
    prune_skipped: !args.prune_stale_parquet,
    skipped_reason: args.prune_stale_parquet ? null : "disabled_by_no_prune_stale_parquet",
    attempted_units: 0,
    skipped_units: 0,
    pruned_after_copy_count: 0,
    pruned_checkpoint_miss_count: 0,
    pruned_force_recheck_count: 0,
    skipped_by_checkpoint: 0,
    planned_checkpoint_updates: 0,
    prune_deleted_count: 0,
    prune_dry_run_delete_count: 0,
    prune_error_count: 0,
    read_list_retry_count: 0,
    read_list_retry_exhausted_count: 0,
    failed_units: [],
    continued_after_unit_failure: false,
    pruned_relative_paths: [],
    pruned_relative_paths_truncated: false,
    manifest_referenced_parquet_count: 0,
    actual_destination_parquet_count: 0,
    units: [],
  };
}

function emptyPruneCheckpointReport(args, pruneCheckpointPath = null) {
  const enabled = args.backup_version === "v2" && Boolean(args.prune_stale_parquet);
  return {
    enabled,
    path: enabled ? V2_PRUNE_STATE_REL_PATH : null,
    checkpoint_path: enabled ? pruneCheckpointPath : null,
    loaded: false,
    existed: false,
    used_for_skip: false,
    force_recheck: Boolean(args.force_prune_recheck),
    skipped_by_checkpoint: 0,
    entries_written: 0,
    planned_entries_written: 0,
    write_skipped_dry_run: false,
    write_skipped_no_changes: false,
    warnings: [],
  };
}

function appendPrunedRelativePaths(pruneReport, unitSummary) {
  const paths = Array.isArray(unitSummary.pruned_relative_paths)
    ? unitSummary.pruned_relative_paths
    : [];
  for (const relPath of paths) {
    if (pruneReport.pruned_relative_paths.length < PRUNED_RELATIVE_PATH_REPORT_LIMIT) {
      pruneReport.pruned_relative_paths.push(`${unitSummary.unit_relative_path}/${relPath}`);
    } else {
      pruneReport.pruned_relative_paths_truncated = true;
    }
  }
}

function recordPruneUnitSummary(pruneReport, unitSummary) {
  pruneReport.prune_attempted = pruneReport.prune_attempted || Boolean(unitSummary.prune_attempted);
  if (unitSummary.prune_skipped) {
    pruneReport.skipped_units += 1;
  } else {
    pruneReport.attempted_units += 1;
  }
  if (unitSummary.prune_reason === "after_copy") {
    pruneReport.pruned_after_copy_count += 1;
  } else if (unitSummary.prune_reason === "checkpoint_missing_or_stale") {
    pruneReport.pruned_checkpoint_miss_count += 1;
  } else if (unitSummary.prune_reason === "force_recheck") {
    pruneReport.pruned_force_recheck_count += 1;
  }
  if (unitSummary.prune_checkpoint_update_planned) {
    pruneReport.planned_checkpoint_updates += 1;
  }
  pruneReport.prune_deleted_count += Number(unitSummary.prune_deleted_count || 0);
  pruneReport.prune_dry_run_delete_count += Number(unitSummary.prune_dry_run_delete_count || 0);
  pruneReport.prune_error_count += Number(unitSummary.prune_error_count || 0);
  pruneReport.read_list_retry_count += Number(unitSummary.read_list_retry_count || 0);
  pruneReport.read_list_retry_exhausted_count += Number(
    unitSummary.read_list_retry_exhausted_count || 0,
  );
  pruneReport.manifest_referenced_parquet_count += Number(unitSummary.manifest_referenced_parquet_count || 0);
  pruneReport.actual_destination_parquet_count += Number(unitSummary.actual_destination_parquet_count || 0);
  if (unitSummary.error) {
    pruneReport.failed_units.push({
      unit_relative_path: unitSummary.unit_relative_path,
      error: unitSummary.error,
      retry_attempts: Number(unitSummary.retry_attempts || 1),
    });
  }
  appendPrunedRelativePaths(pruneReport, unitSummary);
  pruneReport.units.push({
    ...unitSummary,
    pruned_relative_paths: Array.isArray(unitSummary.pruned_relative_paths)
      ? unitSummary.pruned_relative_paths.slice(0, PRUNED_RELATIVE_PATH_REPORT_LIMIT)
      : [],
    pruned_relative_paths_truncated: Array.isArray(unitSummary.pruned_relative_paths)
      && unitSummary.pruned_relative_paths.length > PRUNED_RELATIVE_PATH_REPORT_LIMIT,
  });
}

function recordPruneSkipped(pruneReport, unitRelativePath, reason) {
  recordPruneUnitSummary(pruneReport, {
    prune_attempted: false,
    prune_skipped: true,
    skipped_reason: reason,
    unit_relative_path: unitRelativePath,
    manifest_referenced_parquet_count: 0,
    actual_destination_parquet_count: 0,
    prune_deleted_count: 0,
    prune_dry_run_delete_count: 0,
    prune_error_count: 0,
    pruned_relative_paths: [],
    pruned_relative_paths_truncated: false,
  });
}

function recordPruneCheckpointSkipped(pruneReport, unitRelativePath, manifestHash) {
  pruneReport.skipped_by_checkpoint += 1;
  recordPruneUnitSummary(pruneReport, {
    prune_attempted: false,
    prune_skipped: true,
    skipped_reason: "prune_checkpoint_current",
    unit_relative_path: unitRelativePath,
    manifest_hash: manifestHash,
    manifest_referenced_parquet_count: 0,
    actual_destination_parquet_count: 0,
    prune_deleted_count: 0,
    prune_dry_run_delete_count: 0,
    prune_error_count: 0,
    pruned_relative_paths: [],
    pruned_relative_paths_truncated: false,
  });
}

function attachReadListRetryStats(unitSummary, retryStats) {
  unitSummary.read_list_retry_count = Number(retryStats?.retry_count || 0);
  unitSummary.read_list_retry_exhausted_count = Number(retryStats?.exhausted_count || 0);
  unitSummary.retry_attempts = Number(retryStats?.max_attempts_used || 1);
  return unitSummary;
}

function recordPruneError(pruneReport, unitRelativePath, error, retryStats = null) {
  recordPruneUnitSummary(pruneReport, {
    prune_attempted: true,
    prune_skipped: false,
    unit_relative_path: unitRelativePath,
    manifest_referenced_parquet_count: 0,
    actual_destination_parquet_count: 0,
    prune_deleted_count: 0,
    prune_dry_run_delete_count: 0,
    prune_error_count: 1,
    read_list_retry_count: Number(retryStats?.retry_count || 0),
    read_list_retry_exhausted_count: Number(retryStats?.exhausted_count || 0),
    retry_attempts: Number(retryStats?.max_attempts_used || 1),
    pruned_relative_paths: [],
    pruned_relative_paths_truncated: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function inventoryDayUnits(inventory, args) {
  const units = [];
  for (const domain of args.domains) {
    const inventoryDays = inventory?.domains?.[domain]?.days || {};
    for (const dayUtc of Object.keys(inventoryDays).sort()) {
      const invEntry = inventoryDays[dayUtc];
      const relativePath = normalizePosixRelativePath(invEntry?.relative_path || "");
      if (!relativePath) continue;
      units.push({ domain, day_utc: dayUtc, inventory_entry: invEntry, relative_path: relativePath });
    }
  }
  return units;
}

function pruneCheckpointEntryIsCurrent(pruneState, unitRelativePath, manifestHash) {
  const entry = pruneState?.units?.[unitRelativePath];
  return Boolean(
    entry
    && entry.status === "ok"
    && String(entry.manifest_hash || "").trim()
    && String(entry.manifest_hash || "").trim() === String(manifestHash || "").trim(),
  );
}

function markPruneCheckpointUnitOk(pruneState, unitRelativePath, manifestHash, summary, prunedAt) {
  if (!pruneState.units || typeof pruneState.units !== "object" || Array.isArray(pruneState.units)) {
    pruneState.units = {};
  }
  pruneState.units[unitRelativePath] = {
    manifest_hash: String(manifestHash || "").trim(),
    status: "ok",
    pruned_at: prunedAt,
    manifest_count: Number(summary.manifest_count || 0),
    manifest_referenced_parquet_count: Number(summary.manifest_referenced_parquet_count || 0),
    actual_destination_parquet_count: Number(summary.actual_destination_parquet_count || 0),
    stale_deleted_count: Number(summary.prune_deleted_count || 0),
  };
  pruneState.updated_at = prunedAt;
}

// ---- Planning (inventory-driven) ----

function inventoryDayHash(inventory, domain, dayUtc) {
  return String(
    inventory?.domains?.[domain]?.days?.[dayUtc]?.manifest_hash || "",
  ).trim();
}

function checkpointDayHash(state, domain, dayUtc) {
  return String(state?.domains?.[domain]?.days?.[dayUtc]?.manifest_hash || "").trim();
}

export function planDays(inventory, state, args) {
  const plan = {};
  for (const domain of args.domains) {
    const inventoryDays = inventory?.domains?.[domain]?.days || {};
    const candidates = [];
    let skippedUnchanged = 0;
    for (const dayUtc of Object.keys(inventoryDays).sort()) {
      const invHash = inventoryDayHash(inventory, domain, dayUtc);
      const cpHash = checkpointDayHash(state, domain, dayUtc);
      if (invHash && invHash === cpHash) {
        skippedUnchanged += 1;
        continue;
      }
      candidates.push({
        day_utc: dayUtc,
        inventory_entry: inventoryDays[dayUtc],
      });
    }
    const limited = args.max_days_per_run > 0
      ? candidates.slice(0, args.max_days_per_run)
      : candidates;
    const skippedByLimit = Math.max(0, candidates.length - limited.length);
    plan[domain] = {
      listed_days: Object.keys(inventoryDays).length,
      candidate_days: limited.length,
      skipped_unchanged: skippedUnchanged,
      skipped_by_limit: skippedByLimit,
      candidates: limited,
    };
  }
  return plan;
}

export function planIndexFiles(
  inventory,
  state,
  { indexFileKeys = indexFileKeysForBackupVersion(inventory?.backup_version || "v1") } = {},
) {
  const candidates = [];
  for (const indexKey of indexFileKeys) {
    const invEntry = inventory?.index_files?.[indexKey];
    if (!invEntry || !invEntry.hash || !invEntry.relative_path) continue;
    const cpHash = String(state?.index_files?.[indexKey]?.hash || "").trim();
    if (cpHash && cpHash === String(invEntry.hash).trim()) continue;
    candidates.push({ index_key: indexKey, inventory_entry: invEntry });
  }
  return candidates;
}

export function planIndexTreeUnits(
  inventory,
  state,
  { indexTreeKeys = indexTreeKeysForBackupVersion(inventory?.backup_version || "v1") } = {},
) {
  const candidates = [];
  for (const treeKey of indexTreeKeys) {
    const invUnits = inventory?.index_tree_units?.[treeKey]?.units || {};
    const cpUnits = state?.index_tree_units?.[treeKey]?.units || {};
    for (const unitKey of Object.keys(invUnits).sort()) {
      const invEntry = invUnits[unitKey];
      if (!invEntry || !invEntry.hash || !invEntry.relative_path) continue;
      const cpHash = String(cpUnits[unitKey]?.hash || "").trim();
      if (cpHash && cpHash === String(invEntry.hash).trim()) continue;
      candidates.push({
        tree_key: treeKey,
        unit_key: unitKey,
        inventory_entry: invEntry,
      });
    }
  }
  return candidates;
}

export function planRunManifestUnits(inventory, state, args = {}) {
  const candidates = [];
  const domains = args.domains || RUN_MANIFEST_UNIT_KEYS;
  for (const domainKey of RUN_MANIFEST_UNIT_KEYS) {
    if (!domains.includes(domainKey)) continue;
    const invUnits = inventory?.run_manifest_units?.[domainKey]?.units || {};
    const cpUnits = state?.run_manifest_units?.[domainKey]?.units || {};
    for (const unitKey of Object.keys(invUnits).sort()) {
      const invEntry = invUnits[unitKey];
      if (!invEntry || !invEntry.hash || !invEntry.relative_path) continue;
      const cpHash = String(cpUnits[unitKey]?.hash || "").trim();
      if (cpHash && cpHash === String(invEntry.hash).trim()) continue;
      candidates.push({ domain_key: domainKey, unit_key: unitKey, inventory_entry: invEntry });
    }
  }
  return candidates;
}

export function planCommittedConnectorUnits(inventory, state, args) {
  const candidates = [];
  for (const domainKey of COMMITTED_CONNECTOR_UNIT_KEYS) {
    if (!args.domains.includes(domainKey)) continue;
    const invUnits = inventory?.committed_connector_units?.[domainKey]?.units || {};
    const cpUnits = state?.committed_connector_units?.[domainKey]?.units || {};
    for (const unitKey of Object.keys(invUnits).sort()) {
      const invEntry = invUnits[unitKey];
      if (!invEntry || !invEntry.hash || !invEntry.relative_path) continue;
      const cpHash = String(cpUnits[unitKey]?.hash || "").trim();
      if (cpHash && cpHash === String(invEntry.hash).trim()) continue;
      candidates.push({
        domain_key: domainKey,
        unit_key: unitKey,
        inventory_entry: invEntry,
      });
    }
  }
  return candidates;
}

// ---- Main ----

async function main(args) {
  const startedAt = new Date().toISOString();
  const domainNames = args.domains;
  const indexFileKeys = indexFileKeysForBackupVersion(args.backup_version);
  const indexTreeKeys = indexTreeKeysForBackupVersion(args.backup_version);

  const inventory = loadInventory(
    args.rclone_bin,
    args.source_root,
    args.inventory_rel_path,
    { strict: true },
  );
  const inventoryBackupVersion = String(inventory?.backup_version || "v1").trim().toLowerCase();
  if (inventoryBackupVersion !== args.backup_version) {
    throw new Error(
      `Inventory backup_version=${inventoryBackupVersion} does not match selected backup version ${args.backup_version}. `
      + `Use the matching --inventory-rel-path or rebuild the inventory for ${args.backup_version}.`,
    );
  }

  const checkpointPath = joinTargetPath(args.dest_root, args.state_rel_path);
  const checkpointLoaded = loadCheckpointState(args.rclone_bin, checkpointPath, {
    backupVersion: args.backup_version,
    domainNames,
    indexFileKeys,
    indexTreeKeys,
    retryOptions: dropboxReadListRetryOptions(),
  });
  const state = checkpointLoaded.state;
  const pruneCheckpointEnabled = args.backup_version === "v2" && args.prune_stale_parquet;
  const pruneCheckpointPath = pruneCheckpointEnabled
    ? joinTargetPath(args.dest_root, V2_PRUNE_STATE_REL_PATH)
    : null;
  const pruneCheckpointLoaded = pruneCheckpointEnabled
    ? loadPruneCheckpointState(
      args.rclone_bin,
      pruneCheckpointPath,
      dropboxReadListRetryOptions(),
    )
    : {
      state: null,
      existed: false,
      loaded: false,
      used_for_skip: false,
      warnings: [],
    };
  const pruneCheckpointState = pruneCheckpointLoaded.state;
  let pruneCheckpointDirty = false;
  let pruneCheckpointEntriesWritten = 0;

  const report = {
    ok: true,
    selected_backup_version: args.backup_version,
    started_at: startedAt,
    completed_at: null,
    source_root: args.source_root,
    dest_root: args.dest_root,
    inventory_rel_path: args.inventory_rel_path,
    inventory_backup_version: inventoryBackupVersion,
    inventory_used: true,
    inventory_generated_at: typeof inventory.generated_at === "string" ? inventory.generated_at : null,
    state_checkpoint_path: checkpointPath,
    state_rel_path: args.state_rel_path,
    state_existed: checkpointLoaded.existed,
    dry_run: args.dry_run,
    max_days_per_run: args.max_days_per_run,
    prune_scope: args.prune_scope,
    prune_stale_parquet: args.prune_stale_parquet,
    domains: {},
    index_files: {},
    index_tree_units: {},
    committed_connector_units: {},
    run_manifest_units: {},
    prune: emptyPruneReport(args),
    prune_checkpoint: emptyPruneCheckpointReport(args, pruneCheckpointPath),
    totals: {
      listed_days: 0,
      candidate_days: 0,
      copied_days: 0,
      skipped_unchanged: 0,
      skipped_by_limit: 0,
      index_files_candidates: 0,
      index_files_copied: 0,
      index_tree_units_candidates: 0,
      index_tree_units_copied: 0,
      committed_connector_units_candidates: 0,
      committed_connector_units_copied: 0,
      run_manifest_units_candidates: 0,
      run_manifest_units_copied: 0,
      prune_attempted_units: 0,
      prune_skipped_units: 0,
      prune_deleted_count: 0,
      prune_dry_run_delete_count: 0,
      prune_error_count: 0,
      prune_skipped_by_checkpoint: 0,
    },
  };
  if (pruneCheckpointEnabled) {
    report.prune_checkpoint.loaded = pruneCheckpointLoaded.loaded;
    report.prune_checkpoint.existed = pruneCheckpointLoaded.existed;
    report.prune_checkpoint.used_for_skip =
      Boolean(pruneCheckpointLoaded.used_for_skip && !args.force_prune_recheck);
    report.prune_checkpoint.warnings = [...pruneCheckpointLoaded.warnings];
  }
  const prunedUnitPaths = new Set();

  function syncPruneTotals() {
    report.totals.prune_attempted_units = report.prune.attempted_units;
    report.totals.prune_skipped_units = report.prune.skipped_units;
    report.totals.prune_deleted_count = report.prune.prune_deleted_count;
    report.totals.prune_dry_run_delete_count = report.prune.prune_dry_run_delete_count;
    report.totals.prune_error_count = report.prune.prune_error_count;
    report.totals.prune_skipped_by_checkpoint = report.prune.skipped_by_checkpoint;
    report.prune_checkpoint.skipped_by_checkpoint = report.prune.skipped_by_checkpoint;
    report.prune_checkpoint.planned_entries_written = report.prune.planned_checkpoint_updates;
    report.prune_checkpoint.entries_written = pruneCheckpointEntriesWritten;
  }

  function reconcileCopiedDayUnit(invEntry, { dryRunManifestRoot = null } = {}) {
    const relativePath = normalizePosixRelativePath(invEntry?.relative_path || "");
    const manifestHash = String(invEntry?.manifest_hash || "").trim();
    if (!relativePath) {
      throw new Error("Cannot prune copied unit with missing inventory relative_path");
    }
    if (!manifestHash) {
      throw new Error(`Cannot prune copied unit ${relativePath} with missing inventory manifest_hash`);
    }
    if (!args.prune_stale_parquet) {
      recordPruneSkipped(report.prune, relativePath, "disabled_by_no_prune_stale_parquet");
      syncPruneTotals();
      return;
    }
    const retryStats = emptyReadListRetryStats();
    try {
      const destDayPath = joinTargetPath(args.dest_root, relativePath);
      const manifestRootPath = dryRunManifestRoot || destDayPath;
      const readListRetryOptions = dropboxReadListRetryOptions({ retryStats });
      const summary = pruneStaleParquetForUnit({
        rcloneBin: args.rclone_bin,
        manifestRootPath,
        destUnitPath: destDayPath,
        unitRelativePath: relativePath,
        dryRun: args.dry_run,
        manifestReadListRetryOptions: dryRunManifestRoot ? null : readListRetryOptions,
        destinationReadListRetryOptions: readListRetryOptions,
      });
      attachReadListRetryStats(summary, retryStats);
      summary.prune_reason = "after_copy";
      summary.manifest_hash = manifestHash;
      if (pruneCheckpointEnabled) {
        summary.prune_checkpoint_update_planned = true;
        if (!args.dry_run) {
          markPruneCheckpointUnitOk(
            pruneCheckpointState,
            relativePath,
            manifestHash,
            summary,
            new Date().toISOString(),
          );
          pruneCheckpointDirty = true;
          pruneCheckpointEntriesWritten += 1;
        }
      }
      recordPruneUnitSummary(report.prune, summary);
      prunedUnitPaths.add(relativePath);
      syncPruneTotals();
    } catch (error) {
      recordPruneError(report.prune, relativePath, error, retryStats);
      syncPruneTotals();
      writeReport(args.report_out, report);
      throw error;
    }
  }

  // ---- Plan + copy day folders, per domain ----
  const dayPlan = planDays(inventory, state, args);
  for (const domain of args.domains) {
    const domainPlan = dayPlan[domain];
    const domainSummary = {
      listed_days: domainPlan.listed_days,
      candidate_days: domainPlan.candidate_days,
      copied_days: 0,
      skipped_unchanged: domainPlan.skipped_unchanged,
      skipped_by_limit: domainPlan.skipped_by_limit,
      copied_day_list: [],
    };

    for (const candidate of domainPlan.candidates) {
      const dayUtc = candidate.day_utc;
      const invEntry = candidate.inventory_entry;
      const relativeDayPath = String(invEntry.relative_path || "").trim();
      const manifestRelativePath = String(invEntry.manifest_relative_path || "").trim();
      const manifestHash = String(invEntry.manifest_hash || "").trim();
      if (!relativeDayPath || !manifestRelativePath || !manifestHash) {
        throw new Error(
          `Inventory day entry for ${domain}/${dayUtc} is missing required fields`,
        );
      }
      const sourceDayPath = joinTargetPath(args.source_root, relativeDayPath);
      const destDayPath = joinTargetPath(args.dest_root, relativeDayPath);

      copyDayFolder(args.rclone_bin, sourceDayPath, destDayPath, args.dry_run);
      reconcileCopiedDayUnit(invEntry, {
        dryRunManifestRoot: args.dry_run ? sourceDayPath : null,
      });

      if (!args.dry_run) {
        const copiedAt = new Date().toISOString();
        markDayCopied(state, domain, dayUtc, {
          manifest_key: manifestRelativePath,
          copied_at: copiedAt,
          manifest_hash: manifestHash,
        });
        writeCheckpointState(args.rclone_bin, checkpointPath, state);
      }

      domainSummary.copied_days += 1;
      domainSummary.copied_day_list.push(dayUtc);
    }

    report.domains[domain] = domainSummary;
    report.totals.listed_days += domainSummary.listed_days;
    report.totals.candidate_days += domainSummary.candidate_days;
    report.totals.copied_days += domainSummary.copied_days;
    report.totals.skipped_unchanged += domainSummary.skipped_unchanged;
    report.totals.skipped_by_limit += domainSummary.skipped_by_limit;
  }

  if (args.prune_stale_parquet && args.prune_scope === "all") {
    const allPruneFailures = [];
    for (const unit of inventoryDayUnits(inventory, args)) {
      if (allPruneFailures.length > 0) {
        report.prune.continued_after_unit_failure = true;
      }
      const manifestHash = String(unit.inventory_entry?.manifest_hash || "").trim();
      if (prunedUnitPaths.has(unit.relative_path)) {
        recordPruneSkipped(report.prune, unit.relative_path, "already_pruned_after_copy");
        syncPruneTotals();
        continue;
      }
      if (!manifestHash) {
        const error = new Error(`Cannot prune unit ${unit.relative_path} with missing inventory manifest_hash`);
        recordPruneError(report.prune, unit.relative_path, error);
        syncPruneTotals();
        writeReport(args.report_out, report);
        allPruneFailures.push(error);
        continue;
      }
      if (
        pruneCheckpointEnabled
        && !args.force_prune_recheck
        && pruneCheckpointLoaded.used_for_skip
        && pruneCheckpointEntryIsCurrent(pruneCheckpointState, unit.relative_path, manifestHash)
      ) {
        recordPruneCheckpointSkipped(report.prune, unit.relative_path, manifestHash);
        syncPruneTotals();
        continue;
      }
      const retryStats = emptyReadListRetryStats();
      try {
        const destDayPath = joinTargetPath(args.dest_root, unit.relative_path);
        const summary = pruneStaleParquetForUnit({
          rcloneBin: args.rclone_bin,
          manifestRootPath: destDayPath,
          destUnitPath: destDayPath,
          unitRelativePath: unit.relative_path,
          dryRun: args.dry_run,
          readListRetryOptions: dropboxReadListRetryOptions({ retryStats }),
        });
        attachReadListRetryStats(summary, retryStats);
        summary.prune_reason = args.force_prune_recheck
          ? "force_recheck"
          : "checkpoint_missing_or_stale";
        summary.manifest_hash = manifestHash;
        if (pruneCheckpointEnabled) {
          summary.prune_checkpoint_update_planned = true;
          if (!args.dry_run) {
            markPruneCheckpointUnitOk(
              pruneCheckpointState,
              unit.relative_path,
              manifestHash,
              summary,
              new Date().toISOString(),
            );
            pruneCheckpointDirty = true;
            pruneCheckpointEntriesWritten += 1;
          }
        }
        recordPruneUnitSummary(report.prune, summary);
        prunedUnitPaths.add(unit.relative_path);
        syncPruneTotals();
      } catch (error) {
        recordPruneError(report.prune, unit.relative_path, error, retryStats);
        syncPruneTotals();
        writeReport(args.report_out, report);
        allPruneFailures.push(error);
      }
    }
    if (allPruneFailures.length > 0) {
      syncPruneTotals();
      if (pruneCheckpointEnabled) {
        if (args.dry_run) {
          report.prune_checkpoint.write_skipped_dry_run = true;
        } else if (pruneCheckpointDirty) {
          writePruneCheckpointState(args.rclone_bin, pruneCheckpointPath, pruneCheckpointState);
          report.prune_checkpoint.entries_written = pruneCheckpointEntriesWritten;
        } else {
          report.prune_checkpoint.write_skipped_no_changes = true;
        }
      }
      report.ok = false;
      report.completed_at = new Date().toISOString();
      writeReport(args.report_out, report);
      throw new Error(
        `Dropbox prune audit failed for ${allPruneFailures.length} inventory-listed unit(s); `
        + "see prune.failed_units in the report",
      );
    }
  }

  // ---- Plan + copy latest index files ----
  const indexFileCandidates = planIndexFiles(inventory, state, { indexFileKeys });
  report.totals.index_files_candidates = indexFileCandidates.length;
  for (const candidate of indexFileCandidates) {
    const invEntry = candidate.inventory_entry;
    const relativePath = String(invEntry.relative_path || "").trim();
    const hash = String(invEntry.hash || "").trim();
    if (!relativePath || !hash) {
      throw new Error(
        `Inventory index_files entry for ${candidate.index_key} is missing required fields`,
      );
    }
    const sourcePath = joinTargetPath(args.source_root, relativePath);
    const destPath = joinTargetPath(args.dest_root, relativePath);
    copyFilePath(args.rclone_bin, sourcePath, destPath, args.dry_run);

    if (!args.dry_run) {
      const copiedAt = new Date().toISOString();
      markIndexFileCopied(state, candidate.index_key, {
        relative_path: relativePath,
        copied_at: copiedAt,
        hash,
        size: Number.isFinite(Number(invEntry.size)) ? Math.trunc(Number(invEntry.size)) : null,
      });
      writeCheckpointState(args.rclone_bin, checkpointPath, state);
      report.totals.index_files_copied += 1;
    }
    report.index_files[candidate.index_key] = {
      relative_path: relativePath,
      copied: !args.dry_run,
    };
  }

  // ---- Plan + copy timeseries index tree per-(day, connector) units ----
  const indexTreeCandidates = planIndexTreeUnits(inventory, state, { indexTreeKeys });
  report.totals.index_tree_units_candidates = indexTreeCandidates.length;
  for (const candidate of indexTreeCandidates) {
    const invEntry = candidate.inventory_entry;
    const relativePath = String(invEntry.relative_path || "").trim();
    const hash = String(invEntry.hash || "").trim();
    if (!relativePath || !hash) {
      throw new Error(
        `Inventory index_tree_units entry for ${candidate.tree_key}/${candidate.unit_key} is missing required fields`,
      );
    }
    const sourcePath = joinTargetPath(args.source_root, relativePath);
    const destPath = joinTargetPath(args.dest_root, relativePath);
    copyFilePath(args.rclone_bin, sourcePath, destPath, args.dry_run);

    if (!args.dry_run) {
      const copiedAt = new Date().toISOString();
      markIndexTreeUnitCopied(state, candidate.tree_key, candidate.unit_key, {
        relative_path: relativePath,
        copied_at: copiedAt,
        hash,
        size: Number.isFinite(Number(invEntry.size)) ? Math.trunc(Number(invEntry.size)) : null,
      });
      writeCheckpointState(args.rclone_bin, checkpointPath, state);
      report.totals.index_tree_units_copied += 1;
    }
    if (!report.index_tree_units[candidate.tree_key]) {
      report.index_tree_units[candidate.tree_key] = { copied_units: [] };
    }
    report.index_tree_units[candidate.tree_key].copied_units.push(candidate.unit_key);
  }

  // ---- Plan + copy Phase B run manifests ----
  const runManifestCandidates = planRunManifestUnits(inventory, state, args);
  report.totals.run_manifest_units_candidates = runManifestCandidates.length;
  for (const candidate of runManifestCandidates) {
    const invEntry = candidate.inventory_entry;
    const relativePath = String(invEntry.relative_path || "").trim();
    const hash = String(invEntry.hash || "").trim();
    if (!relativePath || !hash) {
      throw new Error(
        `Inventory run_manifest_units entry for ${candidate.domain_key}/${candidate.unit_key} is missing required fields`,
      );
    }
    const sourcePath = joinTargetPath(args.source_root, relativePath);
    const destPath = joinTargetPath(args.dest_root, relativePath);
    copyFilePath(args.rclone_bin, sourcePath, destPath, args.dry_run);

    if (!args.dry_run) {
      const copiedAt = new Date().toISOString();
      markRunManifestUnitCopied(state, candidate.domain_key, candidate.unit_key, {
        relative_path: relativePath,
        copied_at: copiedAt,
        hash,
        size: Number.isFinite(Number(invEntry.size)) ? Math.trunc(Number(invEntry.size)) : null,
      });
      writeCheckpointState(args.rclone_bin, checkpointPath, state);
      report.totals.run_manifest_units_copied += 1;
    }
    if (!report.run_manifest_units[candidate.domain_key]) {
      report.run_manifest_units[candidate.domain_key] = { copied_units: [] };
    }
    report.run_manifest_units[candidate.domain_key].copied_units.push(candidate.unit_key);
  }

  // ---- Plan + copy committed observations connector manifests ----
  const committedConnectorCandidates = planCommittedConnectorUnits(inventory, state, args);
  report.totals.committed_connector_units_candidates = committedConnectorCandidates.length;
  for (const candidate of committedConnectorCandidates) {
    const invEntry = candidate.inventory_entry;
    const relativePath = String(invEntry.relative_path || "").trim();
    const hash = String(invEntry.hash || "").trim();
    if (!relativePath || !hash) {
      throw new Error(
        `Inventory committed_connector_units entry for ${candidate.domain_key}/${candidate.unit_key} is missing required fields`,
      );
    }
    const sourcePath = joinTargetPath(args.source_root, relativePath);
    const destPath = joinTargetPath(args.dest_root, relativePath);
    copyFilePath(args.rclone_bin, sourcePath, destPath, args.dry_run);

    if (!args.dry_run) {
      const copiedAt = new Date().toISOString();
      markCommittedConnectorUnitCopied(state, candidate.domain_key, candidate.unit_key, {
        relative_path: relativePath,
        copied_at: copiedAt,
        hash,
        size: Number.isFinite(Number(invEntry.size)) ? Math.trunc(Number(invEntry.size)) : null,
      });
      writeCheckpointState(args.rclone_bin, checkpointPath, state);
      report.totals.committed_connector_units_copied += 1;
    }
    if (!report.committed_connector_units[candidate.domain_key]) {
      report.committed_connector_units[candidate.domain_key] = { copied_units: [] };
    }
    report.committed_connector_units[candidate.domain_key].copied_units.push(candidate.unit_key);
  }

  if (pruneCheckpointEnabled) {
    syncPruneTotals();
    if (args.dry_run) {
      report.prune_checkpoint.write_skipped_dry_run = true;
    } else if (pruneCheckpointDirty) {
      writePruneCheckpointState(args.rclone_bin, pruneCheckpointPath, pruneCheckpointState);
      report.prune_checkpoint.entries_written = pruneCheckpointEntriesWritten;
    } else {
      report.prune_checkpoint.write_skipped_no_changes = true;
    }
  }

  report.completed_at = new Date().toISOString();
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

async function runCli() {
  let reportOutPath = DEFAULT_REPORT_OUT;
  try {
    const parsedArgs = parseArgs(process.argv.slice(2));
    reportOutPath = parsedArgs.report_out || reportOutPath;
    if (parsedArgs.show_version) {
      const selected = {
        ok: true,
        selected_backup_version: parsedArgs.backup_version,
        default_inventory_rel_path: defaultInventoryRelPathForBackupVersion(parsedArgs.backup_version),
        inventory_rel_path: parsedArgs.inventory_rel_path,
        default_state_rel_path: defaultStateRelPathForBackupVersion(parsedArgs.backup_version),
        state_rel_path: parsedArgs.state_rel_path,
        default_domains: domainNamesForBackupVersion(parsedArgs.backup_version),
        index_file_keys: indexFileKeysForBackupVersion(parsedArgs.backup_version),
        index_tree_keys: indexTreeKeysForBackupVersion(parsedArgs.backup_version),
        default_prune_scope: parsedArgs.prune_scope,
        prune_checkpoint_rel_path: parsedArgs.backup_version === "v2" ? V2_PRUNE_STATE_REL_PATH : null,
      };
      console.log(JSON.stringify(selected, null, 2));
      return;
    }
    await main(parsedArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let payload = { ok: false, error: message };
    if (reportOutPath) {
      try {
        if (fs.existsSync(path.resolve(reportOutPath))) {
          const partial = JSON.parse(fs.readFileSync(path.resolve(reportOutPath), "utf8"));
          if (partial && typeof partial === "object" && !Array.isArray(partial)) {
            payload = { ...partial, ok: false, error: message };
          }
        }
      } catch {
        payload = { ok: false, error: message };
      }
    }
    if (reportOutPath) writeReport(reportOutPath, payload);
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  await runCli();
}
