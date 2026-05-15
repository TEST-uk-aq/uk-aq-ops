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
//     index_tree_units: { observations_timeseries: { units: { "day_utc=.../connector_id=.../manifest.json": {...} } }, ... }
//   }
// Old checkpoint files lacking the new sections are accepted; the new sections
// are populated on first inventory-driven run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinTargetPath,
  rcloneCatMaybe,
  runRclone,
  sha256Hex,
  uploadFromTempFile,
} from "./lib/rclone.mjs";
import {
  DEFAULT_INVENTORY_REL_PATH,
  DOMAIN_NAMES,
  INDEX_FILE_KEYS,
  INDEX_TREE_KEYS,
  loadInventory,
} from "./lib/inventory.mjs";

function parseNonNegativeInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.trunc(value);
  if (intValue < 0) return fallback;
  return intValue;
}

const DEFAULT_STATE_REL_PATH =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH || "").trim()
  || "_ops/checkpoints/r2_history_backup_state_v1.json";
const DEFAULT_MAX_DAYS_PER_RUN = parseNonNegativeInt(
  process.env.UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN,
  0,
);
const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim() || "rclone";
const DEFAULT_REPORT_OUT = String(process.env.UK_AQ_R2_HISTORY_BACKUP_REPORT_OUT || "").trim();
const DEFAULT_INVENTORY_REL_PATH_ENV =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH || "").trim()
  || DEFAULT_INVENTORY_REL_PATH;

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
      `  --inventory-rel-path <p>     Default: ${DEFAULT_INVENTORY_REL_PATH_ENV}`,
      `  --state-rel-path <path>      Default: ${DEFAULT_STATE_REL_PATH}`,
      "  --domain <name>              observations | aqilevels | core (repeatable)",
      "  --max-days-per-run <N>       Safety throttle on day copies; 0 = unlimited",
      `  --rclone-bin <name>          Default: ${DEFAULT_RCLONE_BIN}`,
      "  --report-out <file>          Write JSON report to file",
      "  --dry-run                    Plan only; no copies, no checkpoint writes",
      "  -h, --help",
      "",
      "Requires a valid inventory at <source-root>/<inventory-rel-path>. Run",
      "scripts/backup_r2/build_backup_inventory.mjs first.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    dest_root: "",
    inventory_rel_path: DEFAULT_INVENTORY_REL_PATH_ENV,
    state_rel_path: DEFAULT_STATE_REL_PATH,
    domains: [],
    max_days_per_run: DEFAULT_MAX_DAYS_PER_RUN,
    rclone_bin: DEFAULT_RCLONE_BIN,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
        String(argv[i + 1] || "").trim() || DEFAULT_INVENTORY_REL_PATH_ENV;
      i += 1;
      continue;
    }
    if (arg === "--state-rel-path") {
      args.state_rel_path = String(argv[i + 1] || "").trim() || DEFAULT_STATE_REL_PATH;
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
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.source_root) throw new Error("--source-root is required");
  if (!args.dest_root) throw new Error("--dest-root is required");
  if (!args.inventory_rel_path) throw new Error("--inventory-rel-path cannot be empty");
  if (!args.state_rel_path) throw new Error("--state-rel-path cannot be empty");

  if (args.domains.length === 0) {
    args.domains = [...DOMAIN_NAMES];
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

function emptyIndexTreeUnitsState() {
  const out = {};
  for (const treeKey of INDEX_TREE_KEYS) {
    out[treeKey] = { units: {} };
  }
  return out;
}

function emptyCheckpointState(nowIso) {
  const domains = {};
  for (const domain of DOMAIN_NAMES) {
    domains[domain] = emptyDomainState();
  }
  return {
    version: 1,
    created_at: nowIso,
    updated_at: nowIso,
    domains,
    index_files: {},
    index_tree_units: emptyIndexTreeUnitsState(),
  };
}

function sanitizeCheckpointState(rawState) {
  const nowIso = new Date().toISOString();
  const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
    ? rawState
    : {};

  const domains = {};
  for (const domain of DOMAIN_NAMES) {
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
  for (const indexKey of INDEX_FILE_KEYS) {
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
  const indexTreeUnits = emptyIndexTreeUnitsState();
  const rawTreeUnits = state.index_tree_units && typeof state.index_tree_units === "object" && !Array.isArray(state.index_tree_units)
    ? state.index_tree_units
    : {};
  for (const treeKey of INDEX_TREE_KEYS) {
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

  return {
    version: Number.isFinite(Number(state.version)) ? Number(state.version) : 1,
    created_at: typeof state.created_at === "string" && state.created_at ? state.created_at : nowIso,
    updated_at: typeof state.updated_at === "string" && state.updated_at ? state.updated_at : nowIso,
    domains,
    index_files: indexFiles,
    index_tree_units: indexTreeUnits,
  };
}

function loadCheckpointState(rcloneBin, checkpointPath) {
  const nowIso = new Date().toISOString();
  const result = rcloneCatMaybe(rcloneBin, checkpointPath);
  if (!result.found) {
    return { state: emptyCheckpointState(nowIso), existed: false };
  }
  try {
    return {
      state: sanitizeCheckpointState(JSON.parse(result.text)),
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
  runRclone(rcloneBin, args);
}

function copyFilePath(rcloneBin, sourcePath, destPath, dryRun) {
  const args = ["copyto", sourcePath, destPath, "--check-first"];
  if (dryRun) args.push("--dry-run");
  runRclone(rcloneBin, args);
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

function planDays(inventory, state, args) {
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

function planIndexFiles(inventory, state) {
  const candidates = [];
  for (const indexKey of INDEX_FILE_KEYS) {
    const invEntry = inventory?.index_files?.[indexKey];
    if (!invEntry || !invEntry.hash || !invEntry.relative_path) continue;
    const cpHash = String(state?.index_files?.[indexKey]?.hash || "").trim();
    if (cpHash && cpHash === String(invEntry.hash).trim()) continue;
    candidates.push({ index_key: indexKey, inventory_entry: invEntry });
  }
  return candidates;
}

function planIndexTreeUnits(inventory, state) {
  const candidates = [];
  for (const treeKey of INDEX_TREE_KEYS) {
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

// ---- Main ----

async function main(args) {
  const startedAt = new Date().toISOString();

  const inventory = loadInventory(
    args.rclone_bin,
    args.source_root,
    args.inventory_rel_path,
    { strict: true },
  );

  const checkpointPath = joinTargetPath(args.dest_root, args.state_rel_path);
  const checkpointLoaded = loadCheckpointState(args.rclone_bin, checkpointPath);
  const state = checkpointLoaded.state;

  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: null,
    source_root: args.source_root,
    dest_root: args.dest_root,
    inventory_rel_path: args.inventory_rel_path,
    inventory_used: true,
    inventory_generated_at: typeof inventory.generated_at === "string" ? inventory.generated_at : null,
    state_checkpoint_path: checkpointPath,
    state_existed: checkpointLoaded.existed,
    dry_run: args.dry_run,
    max_days_per_run: args.max_days_per_run,
    domains: {},
    index_files: {},
    index_tree_units: {},
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
    },
  };

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

  // ---- Plan + copy latest index files ----
  const indexFileCandidates = planIndexFiles(inventory, state);
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
  const indexTreeCandidates = planIndexTreeUnits(inventory, state);
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
    await main(parsedArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ok: false, error: message };
    if (reportOutPath) writeReport(reportOutPath, payload);
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  await runCli();
}
