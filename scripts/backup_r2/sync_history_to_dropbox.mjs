#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinTargetPath,
  rcloneCat,
  rcloneCatMaybe,
  rcloneLsjsonFile,
  runRclone,
  runRcloneWithRetry,
  uploadFromTempFile,
} from "./lib/rclone.mjs";
import {
  buildObservationRunManifestStateShard,
  completeObservationMonthState,
  emptyHierarchicalStateRoot,
  markObservationDayCopied,
  migrateLegacyMonthState,
  monthStateIsComplete,
  observationMonthStateShardKey,
  planObservationMonthCopies,
  setStateRootProcessedHash,
  setStateYearProcessedHash,
  sha256Hex,
  stableJson,
  stateMonthEntry,
  stateYearEntry,
  upsertStateMonthSummary,
  validateHierarchicalInventoryRoot,
  validateHierarchicalStateRoot,
  validateObservationMonthInventoryShard,
  validateObservationMonthState,
  validateObservationRunManifestInventoryShard,
  validateObservationRunManifestStateShard,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  syncTimeseriesBindingsToDropbox,
} from "./lib/hierarchical_timeseries_binding_sync_v2.mjs";
import {
  syncCoreToDropbox,
} from "./lib/hierarchical_core_backup_v2.mjs";
import {
  pruneStaleParquetForUnit,
} from "./lib/stale_parquet_prune.mjs";

const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim() || "rclone";
const DEFAULT_INVENTORY_ROOT_PREFIX = String(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX
  || "history/_index_v2/backup_inventory_v2",
).trim().replace(/^\/+|\/+$/g, "");
const DEFAULT_STATE_ROOT_PREFIX = String(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX
  || "_ops/checkpoints/r2_history_backup_state_v2",
).trim().replace(/^\/+|\/+$/g, "");
const DEFAULT_LEGACY_STATE_KEY = String(
  process.env.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH
  || "_ops/checkpoints/r2_history_backup_state_v2.json",
).trim().replace(/^\/+/, "");
const DEFAULT_REPORT_OUT = String(
  process.env.UK_AQ_R2_HISTORY_HIERARCHICAL_SYNC_REPORT_OUT || "",
).trim();
const DEFAULT_MAX_DAYS = parseNonNegativeInt(
  process.env.UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN,
  0,
);
const DEFAULT_CHECKPOINT_BATCH_UNITS = parsePositiveInt(
  process.env.UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS,
  10,
);
const DEFAULT_CHECKPOINT_FLUSH_SECONDS = parsePositiveInt(
  process.env.UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS,
  60,
);

const DROPBOX_WRITE_RETRY = {
  max_attempts: 7,
  initial_delay_ms: 5_000,
  max_delay_ms: 60_000,
  backoff_multiplier: 2,
  should_retry: (error) => /too_many_write_operations|too many requests|429/i.test(
    error instanceof Error ? error.message : String(error),
  ),
};

const DROPBOX_READ_RETRY = {
  max_attempts: 5,
  initial_delay_ms: 10_000,
  max_delay_ms: 60_000,
  backoff_multiplier: 2,
  should_retry: (error) => (
    /too_many_requests|rate(?:[ _-]?limit|_limited)|too many requests|timeout|timed out|connection reset|connection refused|temporary failure|temporarily unavailable|server error|internal_error|unexpected error occurred|\b5\d\d\b|\b429\b/i
  ).test(error instanceof Error ? error.message : String(error)),
};

function parseNonNegativeInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : fallback;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : fallback;
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/backup_r2/sync_history_to_dropbox.mjs \\",
    "    --source-root <rclone-source-root> \\",
    "    --dest-root <rclone-destination-root> [options]",
    "",
    "Required:",
    "  --source-root <root>          Example: uk_aq_r2_test:uk-aq-history-cic-test",
    "  --dest-root <root>            Example: uk_aq_dropbox:CIC-Test/R2_history_backup",
    "",
    "Options:",
    `  --inventory-root-prefix <p>  Default: ${DEFAULT_INVENTORY_ROOT_PREFIX}`,
    `  --state-root-prefix <p>      Default: ${DEFAULT_STATE_ROOT_PREFIX}`,
    `  --legacy-state-key <p>       Default: ${DEFAULT_LEGACY_STATE_KEY}`,
    `  --max-days-per-run <N>       Default: ${DEFAULT_MAX_DAYS}; 0 = unlimited`,
    `  --checkpoint-batch-units <N> Default: ${DEFAULT_CHECKPOINT_BATCH_UNITS}`,
    `  --checkpoint-flush-seconds <N> Default: ${DEFAULT_CHECKPOINT_FLUSH_SECONDS}`,
    `  --rclone-bin <name>          Default: ${DEFAULT_RCLONE_BIN}`,
    "  --no-prune-stale-parquet     Disable post-copy stale observation Parquet pruning",
    "  --force-prune-recheck        Audit all current observation days for stale Dropbox Parquet",
    "  --dry-run                    Plan/copy/prune dry-run only",
    "  --report-out <file>          Write JSON report",
    "  -h, --help",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    dest_root: "",
    inventory_root_prefix: DEFAULT_INVENTORY_ROOT_PREFIX,
    state_root_prefix: DEFAULT_STATE_ROOT_PREFIX,
    legacy_state_key: DEFAULT_LEGACY_STATE_KEY,
    max_days_per_run: DEFAULT_MAX_DAYS,
    checkpoint_batch_units: DEFAULT_CHECKPOINT_BATCH_UNITS,
    checkpoint_flush_seconds: DEFAULT_CHECKPOINT_FLUSH_SECONDS,
    rclone_bin: DEFAULT_RCLONE_BIN,
    prune_stale_parquet: true,
    force_prune_recheck: false,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-root") {
      args.source_root = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--dest-root") {
      args.dest_root = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--inventory-root-prefix") {
      args.inventory_root_prefix = String(argv[index + 1] || "")
        .trim().replace(/^\/+|\/+$/g, "");
      index += 1;
      continue;
    }
    if (arg === "--state-root-prefix") {
      args.state_root_prefix = String(argv[index + 1] || "")
        .trim().replace(/^\/+|\/+$/g, "");
      index += 1;
      continue;
    }
    if (arg === "--legacy-state-key") {
      args.legacy_state_key = String(argv[index + 1] || "")
        .trim().replace(/^\/+/, "");
      index += 1;
      continue;
    }
    if (arg === "--max-days-per-run") {
      const value = parseNonNegativeInt(argv[index + 1], Number.NaN);
      if (!Number.isFinite(value)) {
        throw new Error("--max-days-per-run must be a non-negative integer");
      }
      args.max_days_per_run = value;
      index += 1;
      continue;
    }
    if (arg === "--checkpoint-batch-units") {
      const value = parsePositiveInt(argv[index + 1], Number.NaN);
      if (!Number.isFinite(value)) {
        throw new Error("--checkpoint-batch-units must be a positive integer");
      }
      args.checkpoint_batch_units = value;
      index += 1;
      continue;
    }
    if (arg === "--checkpoint-flush-seconds") {
      const value = parsePositiveInt(argv[index + 1], Number.NaN);
      if (!Number.isFinite(value)) {
        throw new Error("--checkpoint-flush-seconds must be a positive integer");
      }
      args.checkpoint_flush_seconds = value;
      index += 1;
      continue;
    }
    if (arg === "--rclone-bin") {
      args.rclone_bin = String(argv[index + 1] || "").trim() || DEFAULT_RCLONE_BIN;
      index += 1;
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
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.source_root) throw new Error("--source-root is required");
  if (!args.dest_root) throw new Error("--dest-root is required");
  if (!args.inventory_root_prefix) {
    throw new Error("--inventory-root-prefix is required");
  }
  if (!args.state_root_prefix) throw new Error("--state-root-prefix is required");
  if (!args.legacy_state_key) throw new Error("--legacy-state-key is required");
  if (args.force_prune_recheck && !args.prune_stale_parquet) {
    throw new Error("--force-prune-recheck cannot be combined with --no-prune-stale-parquet");
  }
  return args;
}

function writeReport(reportOut, payload) {
  if (!reportOut) return;
  const output = path.resolve(reportOut);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJsonRequired(
  rcloneBin,
  root,
  relativePath,
  retryOptions = null,
) {
  const text = rcloneCat(
    rcloneBin,
    joinTargetPath(root, relativePath),
    retryOptions,
  );
  try {
    return { text, parsed: JSON.parse(text) };
  } catch (error) {
    throw new Error(
      `Invalid JSON at ${relativePath}: ${error?.message || error}`,
    );
  }
}

function readJsonMaybe(
  rcloneBin,
  root,
  relativePath,
  retryOptions = null,
) {
  const normalizedPath = String(relativePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parentRelativePath = path.posix.dirname(normalizedPath);
  const fileName = path.posix.basename(normalizedPath);
  const parentPath = joinTargetPath(
    root,
    parentRelativePath === "." ? "" : parentRelativePath,
  );
  const entry = rcloneLsjsonFile(
    rcloneBin,
    parentPath,
    fileName,
    { retryOptions },
  );
  if (!entry) return null;
  return readJsonRequired(
    rcloneBin,
    root,
    normalizedPath,
    retryOptions,
  );
}

function uploadJson({
  rcloneBin,
  root,
  relativePath,
  payload,
  dryRun,
}) {
  const text = stableJson(payload);
  const hash = sha256Hex(text);
  const targetPath = joinTargetPath(root, relativePath);
  const existing = rcloneCatMaybe(
    rcloneBin,
    targetPath,
    DROPBOX_READ_RETRY,
  );
  const changed = !existing.found || existing.text !== text;
  if (changed && !dryRun) {
    uploadFromTempFile(
      rcloneBin,
      targetPath,
      text,
      "uk_aq_hierarchical_state_",
      DROPBOX_WRITE_RETRY,
    );
  }
  return {
    text,
    hash,
    size: Buffer.byteLength(text, "utf8"),
    changed,
    written: changed && !dryRun,
  };
}

function copyWithRetry(rcloneBin, args, dryRun) {
  const fullArgs = [...args];
  if (dryRun) fullArgs.push("--dry-run");
  if (dryRun) return runRclone(rcloneBin, fullArgs);
  return runRcloneWithRetry(rcloneBin, fullArgs, DROPBOX_WRITE_RETRY);
}

function copyAndVerifyJsonFile({
  rcloneBin,
  sourceRoot,
  destRoot,
  relativePath,
  dryRun,
}) {
  const sourceText = rcloneCat(
    rcloneBin,
    joinTargetPath(sourceRoot, relativePath),
  );
  copyWithRetry(
    rcloneBin,
    [
      "copyto",
      joinTargetPath(sourceRoot, relativePath),
      joinTargetPath(destRoot, relativePath),
      "--check-first",
    ],
    dryRun,
  );
  if (dryRun) {
    return {
      relative_path: relativePath,
      source_hash: sha256Hex(sourceText),
      verified: false,
      dry_run: true,
    };
  }
  const destText = rcloneCat(
    rcloneBin,
    joinTargetPath(destRoot, relativePath),
    DROPBOX_READ_RETRY,
  );
  const sourceHash = sha256Hex(sourceText);
  const destHash = sha256Hex(destText);
  if (sourceHash !== destHash) {
    throw new Error(
      `Copied JSON verification failed for ${relativePath}: `
      + `source=${sourceHash} destination=${destHash}`,
    );
  }
  return {
    relative_path: relativePath,
    source_hash: sourceHash,
    verified: true,
    dry_run: false,
  };
}

function parseDayManifestHash(text, relativePath) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid destination day manifest JSON at ${relativePath}: `
      + `${error?.message || error}`,
    );
  }
  const hash = String(manifest?.manifest_hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Destination day manifest has invalid manifest_hash: ${relativePath}`);
  }
  return hash;
}

function copyAndVerifyObservationDay({ args, day }) {
  const sourceDayPath = joinTargetPath(args.source_root, day.relative_path);
  const destDayPath = joinTargetPath(args.dest_root, day.relative_path);
  copyWithRetry(
    args.rclone_bin,
    [
      "copy",
      sourceDayPath,
      destDayPath,
      "--check-first",
      "--transfers", "8",
      "--checkers", "16",
      "--fast-list",
    ],
    args.dry_run,
  );

  let prune = null;
  if (args.prune_stale_parquet) {
    prune = pruneStaleParquetForUnit({
      rcloneBin: args.rclone_bin,
      manifestRootPath: args.dry_run ? sourceDayPath : destDayPath,
      destUnitPath: destDayPath,
      unitRelativePath: day.relative_path,
      dryRun: args.dry_run,
      manifestReadListRetryOptions: args.dry_run ? null : DROPBOX_READ_RETRY,
      destinationReadListRetryOptions: DROPBOX_READ_RETRY,
      deleteRetryOptions: DROPBOX_WRITE_RETRY,
    });
  }

  if (args.dry_run) {
    return { verified: false, dry_run: true, prune };
  }
  const destinationManifestPath = joinTargetPath(
    args.dest_root,
    day.manifest_key,
  );
  const destinationText = rcloneCat(
    args.rclone_bin,
    destinationManifestPath,
    DROPBOX_READ_RETRY,
  );
  const destinationHash = parseDayManifestHash(
    destinationText,
    day.manifest_key,
  );
  if (destinationHash !== day.manifest_hash) {
    throw new Error(
      `Copied day verification failed for ${day.day_utc}: `
      + `expected=${day.manifest_hash} destination=${destinationHash}`,
    );
  }
  return { verified: true, dry_run: false, prune };
}

function copyAndVerifyCoreDay({ args, day }) {
  const sourceDayPath = joinTargetPath(args.source_root, day.relative_path);
  const destDayPath = joinTargetPath(args.dest_root, day.relative_path);
  const sourceManifestText = rcloneCat(
    args.rclone_bin,
    joinTargetPath(args.source_root, day.manifest_key),
  );
  const sourceHash = sha256Hex(sourceManifestText);
  copyWithRetry(
    args.rclone_bin,
    [
      "copy",
      sourceDayPath,
      destDayPath,
      "--check-first",
      "--transfers", "8",
      "--checkers", "16",
      "--fast-list",
    ],
    args.dry_run,
  );
  if (args.dry_run) {
    return { source_hash: sourceHash, verified: false, dry_run: true };
  }
  const destinationManifestText = rcloneCat(
    args.rclone_bin,
    joinTargetPath(args.dest_root, day.manifest_key),
    DROPBOX_READ_RETRY,
  );
  const destinationHash = sha256Hex(destinationManifestText);
  if (destinationHash !== sourceHash) {
    throw new Error(
      `Copied core day verification failed for ${day.day_utc}: `
      + `source=${sourceHash} destination=${destinationHash}`,
    );
  }
  return { source_hash: sourceHash, verified: true, dry_run: false };
}

function legacyStateOrNull(args) {
  const result = readJsonMaybe(
    args.rclone_bin,
    args.dest_root,
    args.legacy_state_key,
    DROPBOX_READ_RETRY,
  );
  return result?.parsed || null;
}

function stateRootKey(args) {
  return `${args.state_root_prefix}/root.json`;
}

function stateMonthKey(args, year, month) {
  return observationMonthStateShardKey(args.state_root_prefix, year, month);
}

function inventoryRootKey(args) {
  return `${args.inventory_root_prefix}/root.json`;
}

function runManifestStateShardKey(args, stateRoot) {
  return stateRoot?.global_units?.observation_run_manifests?.state_shard_key
    || `${args.state_root_prefix}/global/observation_run_manifests.json`;
}

function migrateLegacyRunManifestState(inventoryShard, legacyState) {
  const legacyUnits =
    legacyState?.run_manifest_units?.observations?.units
    && typeof legacyState.run_manifest_units.observations.units === "object"
      ? legacyState.run_manifest_units.observations.units
      : {};
  const state = buildObservationRunManifestStateShard(
    inventoryShard.units.flatMap((unit) => {
      const legacy = legacyUnits[unit.unit_key];
      const legacyHash = String(legacy?.hash || "").trim().toLowerCase();
      if (legacyHash !== unit.hash) return [];
      return [{
        unit_key: unit.unit_key,
        hash: unit.hash,
        copied_at: String(legacy?.copied_at || "").trim() || null,
      }];
    }),
  );
  if (state.units.length === inventoryShard.units.length) {
    state.processed_source_hash = sha256Hex(stableJson(inventoryShard));
  }
  return state;
}

function yearIsComplete(stateRoot, inventoryYear) {
  const stateYear = stateYearEntry(stateRoot, inventoryYear.year);
  if (!stateYear) return false;
  return inventoryYear.months.every((inventoryMonth) => {
    const stateMonth = stateYear.months.find(
      (entry) => entry.month === inventoryMonth.month,
    );
    return stateMonth?.processed_source_month_hash === inventoryMonth.content_hash;
  });
}

function allYearsComplete(stateRoot, inventoryRoot) {
  return inventoryRoot.observations.years.every(
    (year) => stateYearEntry(stateRoot, year.year)
      ?.processed_source_year_hash === year.content_hash,
  );
}

function runForcedObservationPruneRecheck(args, inventoryRoot, report) {
  if (!args.force_prune_recheck) return;
  const failures = [];
  for (const inventoryYear of inventoryRoot.observations.years) {
    for (const inventoryMonth of inventoryYear.months) {
      const inventoryShard = validateObservationMonthInventoryShard(
        readJsonRequired(
          args.rclone_bin,
          args.source_root,
          inventoryMonth.inventory_shard_key,
        ).parsed,
      );
      if (inventoryShard.source_month_hash !== inventoryMonth.content_hash) {
        failures.push({
          day_utc: `${inventoryYear.year}-${inventoryMonth.month}`,
          error: "inventory month shard hash mismatch during forced prune recheck",
        });
        continue;
      }
      for (const day of inventoryShard.days) {
        try {
          const result = pruneStaleParquetForUnit({
            rcloneBin: args.rclone_bin,
            manifestRootPath: joinTargetPath(args.source_root, day.relative_path),
            destUnitPath: joinTargetPath(args.dest_root, day.relative_path),
            unitRelativePath: day.relative_path,
            dryRun: args.dry_run,
            manifestReadListRetryOptions: null,
            destinationReadListRetryOptions: DROPBOX_READ_RETRY,
            deleteRetryOptions: DROPBOX_WRITE_RETRY,
          });
          report.prune.forced_days_audited += 1;
          report.prune.deleted_count += Number(result.prune_deleted_count || 0);
          report.prune.dry_run_delete_count += Number(
            result.prune_dry_run_delete_count || 0,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ day_utc: day.day_utc, error: message });
        }
      }
    }
  }
  report.prune.forced_failures = failures;
  report.prune.forced_failed_days = failures.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const inventoryResult = readJsonRequired(
    args.rclone_bin,
    args.source_root,
    inventoryRootKey(args),
  );
  const inventoryRoot = validateHierarchicalInventoryRoot(
    inventoryResult.parsed,
  );

  const runManifestInventoryPointer =
    inventoryRoot.global_units.observation_run_manifests;
  const runManifestInventoryResult = readJsonRequired(
    args.rclone_bin,
    args.source_root,
    runManifestInventoryPointer.inventory_shard_key,
  );
  const runManifestInventoryShard =
    validateObservationRunManifestInventoryShard(
      runManifestInventoryResult.parsed,
    );
  const actualRunManifestShardHash = sha256Hex(
    stableJson(runManifestInventoryShard),
  );
  if (actualRunManifestShardHash !== runManifestInventoryPointer.content_hash) {
    throw new Error(
      `Observation run manifest inventory shard hash mismatch: `
      + `root=${runManifestInventoryPointer.content_hash} `
      + `actual=${actualRunManifestShardHash}`,
    );
  }

  const existingStateResult = readJsonMaybe(
    args.rclone_bin,
    args.dest_root,
    stateRootKey(args),
    DROPBOX_READ_RETRY,
  );
  let stateRoot = validateHierarchicalStateRoot(
    existingStateResult?.parsed || emptyHierarchicalStateRoot(args.legacy_state_key),
    args.legacy_state_key,
  );
  const legacyState = existingStateResult ? null : legacyStateOrNull(args);

  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: null,
    dry_run: args.dry_run,
    source_root: args.source_root,
    dest_root: args.dest_root,
    inventory_root_key: inventoryRootKey(args),
    state_root_key: stateRootKey(args),
    migration_mode: existingStateResult ? "none" : "legacy_state_adoption",
    legacy_state_key: args.legacy_state_key,
    max_days_per_run: args.max_days_per_run,
    checkpoint_batch_units: args.checkpoint_batch_units,
    checkpoint_flush_seconds: args.checkpoint_flush_seconds,
    observations: {
      source_root_hash: inventoryRoot.observations.source_root_hash,
      processed_source_root_hash:
        stateRoot.observations.processed_source_root_hash,
      years_skipped: 0,
      months_skipped: 0,
      months_inspected: 0,
      days_candidates: 0,
      days_copied: 0,
      days_dry_run: 0,
      day_list: [],
      hierarchy_files_copied: [],
      state_shards_written: 0,
      checkpoint_flush_count: 0,
      incomplete_months: [],
      incomplete_years: [],
    },
    timeseries_binding: null,
    core: null,
    run_manifests: {
      listed: runManifestInventoryShard.units.length,
      candidates: 0,
      copied: 0,
      dry_run: 0,
    },
    prune: {
      enabled: args.prune_stale_parquet,
      force_recheck: args.force_prune_recheck,
      deleted_count: 0,
      dry_run_delete_count: 0,
      forced_days_audited: 0,
      forced_failed_days: 0,
      forced_failures: [],
    },
  };

  let copiedDayBudget = args.max_days_per_run;
  let stateRootDirty = existingStateResult === null;

  for (const inventoryYear of inventoryRoot.observations.years) {
    const existingStateYear = stateYearEntry(stateRoot, inventoryYear.year);
    if (
      existingStateYear?.processed_source_year_hash
      === inventoryYear.content_hash
    ) {
      report.observations.years_skipped += 1;
      continue;
    }

    for (const inventoryMonth of inventoryYear.months) {
      const existingSummary = stateMonthEntry(
        stateRoot,
        inventoryYear.year,
        inventoryMonth.month,
      );
      if (
        existingSummary?.processed_source_month_hash
        === inventoryMonth.content_hash
      ) {
        report.observations.months_skipped += 1;
        continue;
      }

      report.observations.months_inspected += 1;
      const inventoryShardResult = readJsonRequired(
        args.rclone_bin,
        args.source_root,
        inventoryMonth.inventory_shard_key,
      );
      const inventoryShard = validateObservationMonthInventoryShard(
        inventoryShardResult.parsed,
      );
      if (inventoryShard.source_month_hash !== inventoryMonth.content_hash) {
        throw new Error(
          `Inventory month shard hash mismatch for `
          + `${inventoryYear.year}-${inventoryMonth.month}`,
        );
      }

      const monthStateRelativePath = stateMonthKey(
        args,
        inventoryYear.year,
        inventoryMonth.month,
      );
      const monthStateResult = readJsonMaybe(
        args.rclone_bin,
        args.dest_root,
        monthStateRelativePath,
        DROPBOX_READ_RETRY,
      );
      let monthState = monthStateResult
        ? validateObservationMonthState(
          monthStateResult.parsed,
          inventoryYear.year,
          inventoryMonth.month,
        )
        : migrateLegacyMonthState({
          inventoryShard,
          legacyState,
        });

      let monthStateDirty = monthStateResult === null;
      let dirtyUnits = 0;
      let lastFlushAt = Date.now();

      const flushMonthState = ({ force = false } = {}) => {
        if (!monthStateDirty) return null;
        const elapsedMs = Date.now() - lastFlushAt;
        const due = force
          || dirtyUnits >= args.checkpoint_batch_units
          || elapsedMs >= args.checkpoint_flush_seconds * 1_000;
        if (!due) return null;
        const write = uploadJson({
          rcloneBin: args.rclone_bin,
          root: args.dest_root,
          relativePath: monthStateRelativePath,
          payload: monthState,
          dryRun: args.dry_run,
        });
        report.observations.checkpoint_flush_count += 1;
        if (write.written) report.observations.state_shards_written += 1;
        upsertStateMonthSummary(stateRoot, {
          year: inventoryYear.year,
          month: inventoryMonth.month,
          stateShardKey: monthStateRelativePath,
          processedSourceMonthHash: monthState.processed_source_month_hash,
          stateShardHash: write.hash,
        });
        stateRootDirty = true;
        monthStateDirty = false;
        dirtyUnits = 0;
        lastFlushAt = Date.now();
        return write;
      };

      const candidates = planObservationMonthCopies(monthState, inventoryShard);
      report.observations.days_candidates += candidates.length;
      for (const day of candidates) {
        if (args.max_days_per_run > 0 && copiedDayBudget <= 0) break;
        try {
          const result = copyAndVerifyObservationDay({ args, day });
          if (result.prune) {
            report.prune.deleted_count += Number(
              result.prune.prune_deleted_count || 0,
            );
            report.prune.dry_run_delete_count += Number(
              result.prune.prune_dry_run_delete_count || 0,
            );
          }
          if (args.dry_run) {
            report.observations.days_dry_run += 1;
          } else {
            monthState = markObservationDayCopied(
              monthState,
              day,
              new Date().toISOString(),
            );
            monthStateDirty = true;
            dirtyUnits += 1;
            report.observations.days_copied += 1;
          }
          report.observations.day_list.push(day.day_utc);
          if (args.max_days_per_run > 0) copiedDayBudget -= 1;
          flushMonthState();
        } catch (error) {
          flushMonthState({ force: true });
          if (stateRootDirty && !args.dry_run) {
            uploadJson({
              rcloneBin: args.rclone_bin,
              root: args.dest_root,
              relativePath: stateRootKey(args),
              payload: stateRoot,
              dryRun: false,
            });
          }
          throw error;
        }
      }

      if (!args.dry_run && monthStateIsComplete(monthState, inventoryShard)) {
        copyAndVerifyJsonFile({
          rcloneBin: args.rclone_bin,
          sourceRoot: args.source_root,
          destRoot: args.dest_root,
          relativePath: inventoryMonth.manifest_key,
          dryRun: false,
        });
        report.observations.hierarchy_files_copied.push(
          inventoryMonth.manifest_key,
        );
        monthState = completeObservationMonthState(
          monthState,
          inventoryShard,
        );
        monthStateDirty = true;
        dirtyUnits += 1;
      }

      const write = flushMonthState({ force: true });
      if (!write && monthStateResult === null) {
        const migrationWrite = uploadJson({
          rcloneBin: args.rclone_bin,
          root: args.dest_root,
          relativePath: monthStateRelativePath,
          payload: monthState,
          dryRun: args.dry_run,
        });
        report.observations.checkpoint_flush_count += 1;
        if (migrationWrite.written) {
          report.observations.state_shards_written += 1;
        }
        upsertStateMonthSummary(stateRoot, {
          year: inventoryYear.year,
          month: inventoryMonth.month,
          stateShardKey: monthStateRelativePath,
          processedSourceMonthHash: monthState.processed_source_month_hash,
          stateShardHash: migrationWrite.hash,
        });
        stateRootDirty = true;
      }

      if (
        monthState.processed_source_month_hash
        !== inventoryMonth.content_hash
      ) {
        report.observations.incomplete_months.push(
          `${inventoryYear.year}-${inventoryMonth.month}`,
        );
      }
    }

    if (!args.dry_run && yearIsComplete(stateRoot, inventoryYear)) {
      copyAndVerifyJsonFile({
        rcloneBin: args.rclone_bin,
        sourceRoot: args.source_root,
        destRoot: args.dest_root,
        relativePath: inventoryYear.manifest_key,
        dryRun: false,
      });
      report.observations.hierarchy_files_copied.push(
        inventoryYear.manifest_key,
      );
      setStateYearProcessedHash(
        stateRoot,
        inventoryYear.year,
        inventoryYear.content_hash,
      );
      stateRootDirty = true;
    } else if (!yearIsComplete(stateRoot, inventoryYear)) {
      report.observations.incomplete_years.push(inventoryYear.year);
    }
  }

  try {
    const bindingSync = syncTimeseriesBindingsToDropbox({
      inventoryRoot,
      stateRoot,
      legacyState,
      stateRootPrefix: args.state_root_prefix,
      dryRun: args.dry_run,
      checkpointBatchUnits: args.checkpoint_batch_units,
      checkpointFlushSeconds: args.checkpoint_flush_seconds,
      readInventoryJson: (relativePath) => readJsonRequired(
        args.rclone_bin,
        args.source_root,
        relativePath,
      ).parsed,
      readStateJsonMaybe: (relativePath) => readJsonMaybe(
        args.rclone_bin,
        args.dest_root,
        relativePath,
        DROPBOX_READ_RETRY,
      ),
      writeStateJson: (relativePath, payload) => uploadJson({
        rcloneBin: args.rclone_bin,
        root: args.dest_root,
        relativePath,
        payload,
        dryRun: args.dry_run,
      }),
      copyAndVerifyFile: (relativePath) => copyAndVerifyJsonFile({
        rcloneBin: args.rclone_bin,
        sourceRoot: args.source_root,
        destRoot: args.dest_root,
        relativePath,
        dryRun: args.dry_run,
      }),
    });
    report.timeseries_binding = bindingSync.report;
    stateRootDirty = stateRootDirty || bindingSync.state_root_dirty;
  } catch (error) {
    if (!args.dry_run) {
      uploadJson({
        rcloneBin: args.rclone_bin,
        root: args.dest_root,
        relativePath: stateRootKey(args),
        payload: stateRoot,
        dryRun: false,
      });
    }
    throw error;
  }

  try {
    const coreSync = syncCoreToDropbox({
      inventoryRoot,
      stateRoot,
      legacyState,
      stateRootPrefix: args.state_root_prefix,
      dryRun: args.dry_run,
      checkpointBatchUnits: args.checkpoint_batch_units,
      checkpointFlushSeconds: args.checkpoint_flush_seconds,
      readInventoryJson: (relativePath) => readJsonRequired(
        args.rclone_bin,
        args.source_root,
        relativePath,
      ).parsed,
      readStateJsonMaybe: (relativePath) => readJsonMaybe(
        args.rclone_bin,
        args.dest_root,
        relativePath,
        DROPBOX_READ_RETRY,
      ),
      writeStateJson: (relativePath, payload) => uploadJson({
        rcloneBin: args.rclone_bin,
        root: args.dest_root,
        relativePath,
        payload,
        dryRun: args.dry_run,
      }),
      copyAndVerifyDay: (day) => copyAndVerifyCoreDay({ args, day }),
    });
    report.core = coreSync.report;
    stateRootDirty = stateRootDirty || coreSync.state_root_dirty;
  } catch (error) {
    if (!args.dry_run) {
      uploadJson({
        rcloneBin: args.rclone_bin,
        root: args.dest_root,
        relativePath: stateRootKey(args),
        payload: stateRoot,
        dryRun: false,
      });
    }
    throw error;
  }

  const runStateRelativePath = runManifestStateShardKey(args, stateRoot);
  const runStateResult = readJsonMaybe(
    args.rclone_bin,
    args.dest_root,
    runStateRelativePath,
    DROPBOX_READ_RETRY,
  );
  let runStateShard = runStateResult
    ? validateObservationRunManifestStateShard(runStateResult.parsed)
    : migrateLegacyRunManifestState(runManifestInventoryShard, legacyState);
  const runStateMap = new Map(
    runStateShard.units.map((entry) => [entry.unit_key, entry]),
  );
  const nextRunStateUnits = [];
  for (const unit of runManifestInventoryShard.units) {
    const prior = runStateMap.get(unit.unit_key);
    if (prior?.hash === unit.hash) {
      nextRunStateUnits.push({ ...prior });
      continue;
    }
    report.run_manifests.candidates += 1;
    const copy = copyAndVerifyJsonFile({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      destRoot: args.dest_root,
      relativePath: unit.relative_path,
      dryRun: args.dry_run,
    });
    nextRunStateUnits.push({
      unit_key: unit.unit_key,
      hash: unit.hash,
      copied_at: args.dry_run ? null : new Date().toISOString(),
    });
    if (args.dry_run) report.run_manifests.dry_run += 1;
    else report.run_manifests.copied += 1;
    if (!copy.verified && !args.dry_run) {
      throw new Error(`Run manifest verification failed: ${unit.relative_path}`);
    }
  }
  runStateShard = buildObservationRunManifestStateShard(nextRunStateUnits);
  const allRunUnitsComplete = runManifestInventoryShard.units.every(
    (unit) => nextRunStateUnits.find(
      (entry) => entry.unit_key === unit.unit_key && entry.hash === unit.hash,
    ),
  );
  if (allRunUnitsComplete) {
    runStateShard.processed_source_hash =
      runManifestInventoryPointer.content_hash;
  }
  const runStateWrite = uploadJson({
    rcloneBin: args.rclone_bin,
    root: args.dest_root,
    relativePath: runStateRelativePath,
    payload: runStateShard,
    dryRun: args.dry_run,
  });
  stateRoot.global_units.observation_run_manifests = {
    state_shard_key: runStateRelativePath,
    processed_source_hash: runStateShard.processed_source_hash,
    state_shard_hash: runStateWrite.hash,
  };
  stateRootDirty = true;

  if (!args.dry_run && allYearsComplete(stateRoot, inventoryRoot)) {
    copyAndVerifyJsonFile({
      rcloneBin: args.rclone_bin,
      sourceRoot: args.source_root,
      destRoot: args.dest_root,
      relativePath: inventoryRoot.observations.source_root_manifest_key,
      dryRun: false,
    });
    report.observations.hierarchy_files_copied.push(
      inventoryRoot.observations.source_root_manifest_key,
    );
    setStateRootProcessedHash(
      stateRoot,
      inventoryRoot.observations.source_root_hash,
    );
    stateRootDirty = true;
  }

  if (stateRootDirty) {
    uploadJson({
      rcloneBin: args.rclone_bin,
      root: args.dest_root,
      relativePath: stateRootKey(args),
      payload: stateRoot,
      dryRun: args.dry_run,
    });
  }

  runForcedObservationPruneRecheck(args, inventoryRoot, report);

  report.observations.processed_source_root_hash =
    stateRoot.observations.processed_source_root_hash;
  report.completed_at = new Date().toISOString();
  report.complete = report.observations.incomplete_months.length === 0
    && report.observations.incomplete_years.length === 0
    && report.timeseries_binding.incomplete_ranges.length === 0
    && report.core.complete;
  report.ok = report.prune.forced_failed_days === 0;
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  } else if (!report.complete && !args.dry_run && args.max_days_per_run === 0) {
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const payload = { ok: false, error: message };
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  });
}
